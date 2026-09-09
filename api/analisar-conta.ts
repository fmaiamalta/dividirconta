import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

type Idioma = 'pt' | 'en';

// Mensagens fixas do servidor (não geradas pela IA) — a app envia o idioma
// da interface no pedido, para os erros lerem-se no mesmo idioma que o
// resto do ecrã, em vez de ficarem sempre em português.
const MENSAGENS: Record<Idioma, {
  metodoNaoPermitido: string;
  faltamCampos: string;
  mediaTypeNaoSuportado: (mt: string) => string;
  erroContactarServico: string;
  iaSemTexto: string;
  contaGrandeErro: string;
  contaGrandeDetalhes: string;
  falhaAnalisar: string;
}> = {
  pt: {
    metodoNaoPermitido: 'Método não permitido',
    faltamCampos: 'Faltam os campos imagemBase64 e mediaType',
    mediaTypeNaoSuportado: (mt) => `mediaType não suportado: ${mt}`,
    erroContactarServico: 'Não foi possível contactar o serviço de análise.',
    iaSemTexto: 'A IA não devolveu texto',
    contaGrandeErro: 'Esta conta tem itens a mais para analisar de uma vez.',
    contaGrandeDetalhes: 'Tenta tirar duas fotos, dividindo a conta em duas partes.',
    falhaAnalisar: 'Falha ao analisar a conta',
  },
  en: {
    metodoNaoPermitido: 'Method not allowed',
    faltamCampos: 'Missing imagemBase64 or mediaType fields',
    mediaTypeNaoSuportado: (mt) => `Unsupported mediaType: ${mt}`,
    erroContactarServico: 'Could not reach the analysis service.',
    iaSemTexto: 'The AI did not return any text',
    contaGrandeErro: 'This receipt has too many items to analyse at once.',
    contaGrandeDetalhes: 'Try taking two photos, splitting the receipt into two parts.',
    falhaAnalisar: 'Failed to analyse the receipt',
  },
};

function idiomaValido(valor: unknown): Idioma {
  return valor === 'en' ? 'en' : 'pt';
}

// A única mensagem gerada pela própria IA (o resto do prompt são só
// instruções, a Claude segue-as bem em português independentemente do
// idioma do output) — por isso só esta frase precisa de duas versões.
function promptSistema(idioma: Idioma): string {
  const erroFotoIlegivel =
    idioma === 'en'
      ? "This photo doesn't look like a readable receipt or invoice. Take another photo, well framed and with good light."
      : 'Esta foto não parece ser uma conta ou fatura legível. Tira outra foto, bem enquadrada e com boa luz.';

  return `Analisas fotos de contas/talões (restaurante, café, bilheteira, etc.)
e devolves APENAS um JSON válido, sem texto à volta, sem markdown.

Primeiro verifica se a imagem é mesmo uma conta, talão, fatura ou recibo legível,
com itens e preços visíveis. Se NÃO for (por exemplo: é outra coisa qualquer sem
relação com uma conta, está demasiado desfocada ou escura para ler os valores, ou
está cortada de forma a não mostrar itens com preços), devolve APENAS isto, sem
mais nenhum campo (o valor de "codigo" é sempre exatamente "nao_e_conta",
não traduzas esse campo):

{ "codigo": "nao_e_conta", "erro": "${erroFotoIlegivel}" }

Se for uma conta legível, devolve esta forma exata:

{
  "tipoDocumento": "restaurante" | "bilheteira" | "outro",
  "itens": [
    { "nome": "string", "preco": number, "quantidade": number, "categoria": "comida" | "bebida" | "outro" }
  ]
}

Regras:
- "preco" é o preço unitário, sem símbolo de moeda.
- "quantidade" é o número de unidades desse item na conta (normalmente 1).
- Classifica "categoria" com bom senso: pratos e sobremesas são "comida"; vinho, cerveja,
  água, refrigerantes e café são "bebida"; qualquer outra coisa (taxas, bilhetes, entradas
  de eventos) é "outro".
- Se não conseguires ler algum valor com confiança, não inventes: omite esse item.
- Ignora subtotais, totais e cabeçalhos — só itens reais consumidos ou comprados.
- Se depois de ignorar subtotais e cabeçalhos não sobrar nenhum item legível,
  devolve o erro descrito acima, em vez de um array vazio.
- Os nomes dos itens ficam tal como estão impressos na conta — não traduzas.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Permite chamadas a partir da app (React Native não é bloqueado por CORS,
  // mas isto ajuda se testares a partir do Expo Web)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // O idioma pode não vir (ex: pedido de uma versão antiga da app) — cai
  // em português, que já era o comportamento de sempre.
  const idioma = idiomaValido(req.body?.idioma);
  const msg = MENSAGENS[idioma];

  if (req.method !== 'POST') {
    res.status(405).json({ erro: msg.metodoNaoPermitido });
    return;
  }

  const { imagemBase64, mediaType } = req.body ?? {};

  if (!imagemBase64 || !mediaType) {
    res.status(400).json({ erro: msg.faltamCampos });
    return;
  }

  const TIPOS_ACEITES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!TIPOS_ACEITES.includes(mediaType)) {
    res.status(400).json({ erro: msg.mediaTypeNaoSuportado(mediaType) });
    return;
  }

  // A conta pode chegar como foto (image/jpeg, image/png, image/webp) ou
  // como PDF digitalizado (application/pdf) — a Claude precisa de um tipo
  // de bloco diferente para cada caso.
  const blocoConta =
    mediaType === 'application/pdf'
      ? ({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: imagemBase64 },
        } as const)
      : ({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imagemBase64 },
        } as const);

  let resposta;
  try {
    resposta = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // 2000 era baixo demais para contas com muitos itens (ex: talão de
      // supermercado) — a resposta ficava cortada a meio do JSON e o
      // JSON.parse abaixo falhava com "Unterminated string in JSON".
      max_tokens: 8192,
      system: promptSistema(idioma),
      messages: [
        {
          role: 'user',
          content: [
            blocoConta,
            {
              type: 'text',
              text: 'Extrai os itens desta conta, seguindo exatamente o formato indicado.',
            },
          ],
        },
      ],
    });
  } catch (erro) {
    // Erro vindo do SDK/rede (auth, rate limit, etc.) — fica só no log do
    // servidor. Não vale a pena devolver o texto cru ao cliente, pode ter
    // detalhes internos do pedido que não lhe dizem respeito.
    console.error('Erro ao chamar a Anthropic:', erro);
    res.status(502).json({ erro: msg.erroContactarServico });
    return;
  }

  const blocoTexto = resposta.content.find((c) => c.type === 'text');
  if (!blocoTexto || blocoTexto.type !== 'text') {
    res.status(502).json({ erro: msg.iaSemTexto });
    return;
  }

  // Se a resposta foi cortada por atingir o limite de tokens, o JSON vai
  // estar sempre incompleto — não vale a pena tentar fazer parse, é
  // melhor dar já um erro claro em vez do erro cru do JSON.parse.
  if (resposta.stop_reason === 'max_tokens') {
    res.status(502).json({ erro: msg.contaGrandeErro, detalhes: msg.contaGrandeDetalhes });
    return;
  }

  const textoLimpo = blocoTexto.text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');

  try {
    const dados = JSON.parse(textoLimpo);
    res.status(200).json(dados);
  } catch (erro) {
    // Este é um erro nosso (o prompt pode precisar de ajuste), não do
    // utilizador — os detalhes ajudam a perceber o que aconteceu.
    console.error('Erro ao interpretar a resposta da IA:', erro);
    const detalhes = erro instanceof Error ? erro.message : String(erro);
    res.status(500).json({ erro: msg.falhaAnalisar, detalhes });
  }
}
