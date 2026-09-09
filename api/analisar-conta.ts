import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const PROMPT_SISTEMA = `Analisas fotos de contas/talões (restaurante, café, bilheteira, etc.)
e devolves APENAS um JSON válido, sem texto à volta, sem markdown.

Primeiro verifica se a imagem é mesmo uma conta, talão, fatura ou recibo legível,
com itens e preços visíveis. Se NÃO for (por exemplo: é outra coisa qualquer sem
relação com uma conta, está demasiado desfocada ou escura para ler os valores, ou
está cortada de forma a não mostrar itens com preços), devolve APENAS isto, sem
mais nenhum campo:

{ "erro": "Esta foto não parece ser uma conta ou fatura legível. Tira outra foto, bem enquadrada e com boa luz." }

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
  devolve o erro descrito acima, em vez de um array vazio.`;

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

  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Método não permitido' });
    return;
  }

  const { imagemBase64, mediaType } = req.body ?? {};

  if (!imagemBase64 || !mediaType) {
    res.status(400).json({ erro: 'Faltam os campos imagemBase64 e mediaType' });
    return;
  }

  try {
    const resposta = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // 2000 era baixo demais para contas com muitos itens (ex: talão de
      // supermercado) — a resposta ficava cortada a meio do JSON e o
      // JSON.parse abaixo falhava com "Unterminated string in JSON".
      max_tokens: 8192,
      system: PROMPT_SISTEMA,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imagemBase64,
              },
            },
            {
              type: 'text',
              text: 'Extrai os itens desta conta, seguindo exatamente o formato indicado.',
            },
          ],
        },
      ],
    });

    const blocoTexto = resposta.content.find((c) => c.type === 'text');
    if (!blocoTexto || blocoTexto.type !== 'text') {
      res.status(502).json({ erro: 'A IA não devolveu texto' });
      return;
    }

    // Se a resposta foi cortada por atingir o limite de tokens, o JSON vai
    // estar sempre incompleto — não vale a pena tentar fazer parse, é
    // melhor dar já um erro claro em vez do erro cru do JSON.parse.
    if (resposta.stop_reason === 'max_tokens') {
      res.status(502).json({
        erro: 'Esta conta tem itens a mais para analisar de uma vez.',
        detalhes: 'Tenta tirar duas fotos, dividindo a conta em duas partes.',
      });
      return;
    }

    const textoLimpo = blocoTexto.text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '');

    const dados = JSON.parse(textoLimpo);

    res.status(200).json(dados);
  } catch (erro) {
    console.error('Erro ao analisar conta:', erro);
    const detalhes = erro instanceof Error ? erro.message : String(erro);
    res.status(500).json({ erro: 'Falha ao analisar a conta', detalhes });
  }
}
