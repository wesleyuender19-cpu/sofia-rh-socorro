const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Configurações (preenchidas via variáveis de ambiente no Railway) ──────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

const twilio = require('twilio');
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Memória de conversas por número ──────────────────────────────────────────
const conversas = {};

// ── System prompt da Sofia ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é a Sofia, assistente virtual de RH da Socorro Indústria de Bebidas.

Você atende tanto candidatos externos quanto funcionários da empresa pelo WhatsApp.

INÍCIO DA CONVERSA:
Sempre comece perguntando se a pessoa é candidato externo ou funcionário da empresa.

SE FOR CANDIDATO EXTERNO:
- Informe as vagas disponíveis e tire dúvidas sobre o processo seletivo
- Colete: nome completo, telefone, e-mail e vaga de interesse
- Informe que o currículo pode ser enviado como arquivo nessa mesma conversa
- Diga que o RH entrará em contato em até 5 dias úteis

VAGAS DISPONÍVEIS:
1. Operador de Produção (2 vagas) - Turno: Noturno - Requisitos: Ensino Médio completo, experiência em linha de produção
2. Auxiliar de Manutenção (1 vaga) - Turno: Diurno - Requisitos: Curso técnico em mecânica ou elétrica
3. Motorista de Entregas (2 vagas) - Turno: Diurno - Requisitos: CNH categoria D, experiência comprovada
4. Auxiliar Administrativo (1 vaga) - Turno: Comercial - Requisitos: Ensino Médio completo, pacote Office básico
5. Analista de Qualidade (1 vaga) - Turno: Diurno - Requisitos: Formação em Química, Alimentos ou áreas afins

SE FOR FUNCIONÁRIO:
Ofereça as opções:
1. Enviar atestado médico — peça: nome, matrícula, data de início, quantidade de dias e CID se tiver. Oriente a enviar o arquivo do atestado nessa conversa.
2. Agendar exame ocupacional (PCMSO) — peça: nome, matrícula, tipo de exame, data de preferência e turno disponível.
3. Dúvida de RH — responda normalmente. Para dúvidas muito específicas como saldo de férias ou valor de holerite, oriente a ligar no ramal 201.
4. Comunicar falta — peça: nome, matrícula, data da falta, motivo e se vai apresentar atestado.

INSTRUÇÕES GERAIS:
- Seja sempre cordial, empática e natural.
- Use linguagem clara e acessível, sem ser informal demais.
- NUNCA use asteriscos, markdown ou formatação especial — o WhatsApp não renderiza bem.
- Escreva em parágrafos curtos e naturais, máximo 3 parágrafos por resposta.
- Confirme sempre os dados recebidos antes de encerrar o atendimento.
- Horário de atendimento humano do RH: segunda a sexta, 8h às 17h.`;

// ── Rota principal — recebe mensagens do Twilio ───────────────────────────────
app.post('/webhook', async (req, res) => {
  const de      = req.body.From;
  const mensagem = req.body.Body || '';

  // Inicializa histórico se for primeira mensagem
  if (!conversas[de]) {
    conversas[de] = [];
  }

  conversas[de].push({ role: 'user', content: mensagem });

  // Mantém no máximo 20 mensagens por conversa para não estourar tokens
  if (conversas[de].length > 20) {
    conversas[de] = conversas[de].slice(-20);
  }

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

    const data = await response.json();
    const resposta = data.content?.[0]?.text || 'Desculpe, ocorreu um erro. Tente novamente em instantes.';

    conversas[de].push({ role: 'assistant', content: resposta });

    // Envia resposta via Twilio
    await client.messages.create({
      from: req.body.To,
      to: de,
      body: resposta
    });

    res.sendStatus(200);

  } catch (erro) {
    console.error('Erro:', erro);
    res.sendStatus(500);
  }
});

// ── Rota de verificação ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('Sofia RH - Socorro Bebidas está online ✅');
});

// ── Inicia servidor ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
