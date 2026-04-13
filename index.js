const express    = require('express');
const bodyParser = require('body-parser');
const fetch      = require('node-fetch');
const { Pool }   = require('pg');
const twilio     = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── CORS para o painel acessar ────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Configurações ─────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const DATABASE_URL       = process.env.DATABASE_URL;
const PAINEL_API_KEY     = process.env.PAINEL_API_KEY || 'socorro-rh-2024';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Banco de dados ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidaturas (
      id SERIAL PRIMARY KEY,
      nome TEXT, telefone TEXT, email TEXT, escolaridade TEXT, vaga TEXT, experiencia TEXT,
      recebido_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS atestados (
      id SERIAL PRIMARY KEY,
      nome TEXT, matricula TEXT, setor TEXT,
      data_inicio TEXT, dias TEXT, cid TEXT, medico TEXT,
      recebido_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS exames (
      id SERIAL PRIMARY KEY,
      nome TEXT, matricula TEXT, setor TEXT,
      tipo TEXT, data_preferencia TEXT, turno TEXT, observacoes TEXT,
      recebido_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS faltas (
      id SERIAL PRIMARY KEY,
      nome TEXT, matricula TEXT, setor TEXT,
      data_falta TEXT, motivo TEXT, apresenta_atestado TEXT, descricao TEXT,
      recebido_em TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Banco de dados pronto!');
}

// ── Memória de conversas ──────────────────────────────────────────────────────
const conversas = {};

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é a Sofia, assistente virtual de RH da Socorro Indústria de Bebidas.
Você atende pelo WhatsApp tanto candidatos externos quanto funcionários.

INÍCIO: Sempre pergunte primeiro se a pessoa é candidato externo ou funcionário.

SE FOR CANDIDATO EXTERNO:
- Apresente as vagas disponíveis e tire dúvidas sobre requisitos e benefícios
- Colete os dados abaixo um de cada vez, de forma conversacional e natural:
  1. Nome completo
  2. Telefone
  3. E-mail
  4. Escolaridade (ex: Ensino Médio completo, Técnico, Superior)
  5. Vaga de interesse
- Depois pergunte: "Você tem alguma experiência anterior que gostaria de destacar? Pode ser de empregos anteriores, cursos ou qualquer coisa relevante para a vaga." — se a pessoa quiser responder, ótimo; se não quiser, tudo bem, siga em frente.
- Por último pergunte se a pessoa deseja anexar um currículo em PDF ou imagem nessa conversa. Deixe claro que é opcional e que o cadastro será registrado de qualquer forma.
- Quando tiver os dados principais confirmados, inclua ao final:
[SALVAR_CANDIDATURA:{"nome":"Nome Completo","telefone":"xx xxxxx-xxxx","email":"email@exemplo.com","escolaridade":"Ensino Médio completo","vaga":"Nome da Vaga","experiencia":"Experiência informada ou Não informada"}]
- Informe que o RH entrará em contato em até 5 dias úteis

VAGAS DISPONÍVEIS:
1. Operador de Produção (2 vagas) - Turno Noturno - Ensino Médio, experiência em produção
2. Auxiliar de Manutenção (1 vaga) - Turno Diurno - Curso técnico em mecânica ou elétrica
3. Motorista de Entregas (2 vagas) - Turno Diurno - CNH categoria D
4. Auxiliar Administrativo (1 vaga) - Turno Comercial - Ensino Médio, pacote Office
5. Analista de Qualidade (1 vaga) - Turno Diurno - Formação em Química ou Alimentos

SE FOR FUNCIONÁRIO:
Ofereça as 4 opções abaixo e colete os dados conforme cada caso:

1. ATESTADO MÉDICO: colete nome, matrícula, setor, data de início do afastamento, quantidade de dias e CID se tiver.
Oriente a enviar a foto ou PDF do atestado como arquivo nessa conversa.
Quando confirmado, inclua ao final:
[SALVAR_ATESTADO:{"nome":"Nome","matricula":"00000","setor":"Setor","data_inicio":"DD/MM/AAAA","dias":"2","cid":"","medico":""}]

2. ATENDIMENTO MÉDICO ASSISTENCIAL: o funcionário quer falar com o médico da empresa para solicitar exames, orientações de saúde ou outros atendimentos. Colete nome, matrícula, setor e o motivo do atendimento.
Informe que a equipe médica entrará em contato para agendar.
Quando confirmado, inclua ao final:
[SALVAR_EXAME:{"nome":"Nome","matricula":"00000","setor":"Setor","tipo":"Atendimento Assistencial","data_preferencia":"A definir","turno":"A definir","observacoes":"Motivo do atendimento"}]

3. DÚVIDA DE RH: responda normalmente. Dúvidas específicas como saldo de férias ou valor de holerite: oriente a ligar no ramal 201 ou comparecer ao RH pessoalmente.

4. COMUNICADO DE FALTA: colete nome, matrícula, setor, data da falta, motivo e se vai apresentar atestado.
Quando confirmado, inclua ao final:
[SALVAR_FALTA:{"nome":"Nome","matricula":"00000","setor":"Setor","data_falta":"DD/MM/AAAA","motivo":"Doença","apresenta_atestado":"Sim","descricao":""}]

INSTRUÇÕES GERAIS:
- Seja cordial, empática e natural. Parágrafos curtos, máximo 3 por resposta.
- NUNCA use asteriscos, negrito ou markdown — o WhatsApp não renderiza bem.
- Colete os dados um de cada vez, de forma conversacional.
- Confirme os dados com o usuário antes de salvar.
- Os blocos [SALVAR_...] são invisíveis para o usuário, apenas para o sistema interno.
- Atendimento humano do RH: segunda a sexta, 8h às 17h.`;

// ── Webhook — recebe mensagens do Twilio ──────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const de       = req.body.From;
  const mensagem = req.body.Body || '';
  const numMidia = parseInt(req.body.NumMedia || '0');

  if (!conversas[de]) conversas[de] = [];

  // ── Tratamento de imagem/arquivo ──────────────────────────────────────────
  if (numMidia > 0) {
    const tipoMidia = req.body.MediaContentType0 || '';
    let confirmacao = '';

    if (tipoMidia.startsWith('image/')) {
      confirmacao = 'Imagem recebida com sucesso! Vou registrar que o documento foi enviado. O RH terá acesso ao arquivo para análise.';
    } else if (tipoMidia === 'application/pdf') {
      confirmacao = 'PDF recebido com sucesso! Vou registrar que o documento foi enviado. O RH terá acesso ao arquivo para análise.';
    } else {
      confirmacao = 'Arquivo recebido! O RH terá acesso ao documento enviado.';
    }

    conversas[de].push({ role: 'user', content: '[enviou um arquivo/documento]' });
    conversas[de].push({ role: 'assistant', content: confirmacao });

    await twilioClient.messages.create({ from: req.body.To, to: de, body: confirmacao });
    res.status(200).end();
    return;
  }
  conversas[de].push({ role: 'user', content: mensagem });
  if (conversas[de].length > 20) conversas[de] = conversas[de].slice(-20);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: conversas[de]
      })
    });

    const data   = await response.json();
    let resposta = data.content?.[0]?.text || 'Desculpe, ocorreu um erro. Tente novamente.';

    // ── Detectar e salvar dados no banco ──────────────────────────────────────
    const salvarRegex = /\[SALVAR_(\w+):(.*?)\]/s;
    const match = resposta.match(salvarRegex);

    if (match) {
      const tipo = match[1].toLowerCase();
      try {
        const dados = JSON.parse(match[2]);
        if (tipo === 'candidatura') {
          await pool.query(
            'INSERT INTO candidaturas (nome, telefone, email, escolaridade, vaga, experiencia) VALUES ($1,$2,$3,$4,$5,$6)',
            [dados.nome, dados.telefone, dados.email, dados.escolaridade||'', dados.vaga, dados.experiencia||'Não informada']
          );
        } else if (tipo === 'atestado') {
          await pool.query(
            'INSERT INTO atestados (nome, matricula, setor, data_inicio, dias, cid, medico) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [dados.nome, dados.matricula, dados.setor, dados.data_inicio, dados.dias, dados.cid||'', dados.medico||'']
          );
        } else if (tipo === 'exame') {
          await pool.query(
            'INSERT INTO exames (nome, matricula, setor, tipo, data_preferencia, turno, observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [dados.nome, dados.matricula, dados.setor, dados.tipo, dados.data_preferencia, dados.turno, dados.observacoes||'']
          );
        } else if (tipo === 'falta') {
          await pool.query(
            'INSERT INTO faltas (nome, matricula, setor, data_falta, motivo, apresenta_atestado, descricao) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [dados.nome, dados.matricula, dados.setor, dados.data_falta, dados.motivo, dados.apresenta_atestado, dados.descricao||'']
          );
        }
        console.log(`Salvo no banco: ${tipo}`, dados);
      } catch (e) {
        console.error('Erro ao salvar no banco:', e);
      }
      resposta = resposta.replace(salvarRegex, '').trim();
    }

    conversas[de].push({ role: 'assistant', content: resposta });

    await twilioClient.messages.create({
      from: req.body.To,
      to: de,
      body: resposta
    });

    res.status(200).end();
  } catch (erro) {
    console.error('Erro geral:', erro);
    res.sendStatus(500);
  }
});

// ── Auth do painel ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers['x-api-key'] === PAINEL_API_KEY) return next();
  res.status(401).json({ erro: 'Não autorizado' });
}

// ── Endpoints do painel ───────────────────────────────────────────────────────
app.get('/api/candidaturas', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM candidaturas ORDER BY recebido_em DESC');
  res.json(r.rows);
});
app.get('/api/atestados', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM atestados ORDER BY recebido_em DESC');
  res.json(r.rows);
});
app.get('/api/exames', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM exames ORDER BY recebido_em DESC');
  res.json(r.rows);
});
app.get('/api/faltas', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM faltas ORDER BY recebido_em DESC');
  res.json(r.rows);
});
app.delete('/api/:tabela/:id', auth, async (req, res) => {
  const permitidas = ['candidaturas','atestados','exames','faltas'];
  if (!permitidas.includes(req.params.tabela)) return res.status(400).json({ erro: 'Tabela inválida' });
  await pool.query(`DELETE FROM ${req.params.tabela} WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Sofia RH - Socorro Bebidas está online ✅'));

// ── Iniciar ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
iniciarBanco().then(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
