# Backend — divisão de contas

Função serverless (Vercel) que recebe a foto de uma conta e devolve os
itens já estruturados, usando a API da Anthropic com visão.

## Publicar na Vercel

1. Cria um repositório no GitHub só com esta pasta (ou usa uma subpasta,
   configurando o "Root Directory" nas definições do projeto na Vercel).
2. Em vercel.com, "Add New Project" → escolhe o repositório.
3. Em "Environment Variables", adiciona `ANTHROPIC_API_KEY` com a tua
   chave (consegues gerar uma em console.anthropic.com).
4. Deploy. A Vercel dá-te um URL do tipo
   `https://o-teu-projeto.vercel.app/api/analisar-conta`.

## Testar localmente

```
npm install -g vercel
vercel dev
```

## Chamar a partir da app

POST para `/api/analisar-conta` com corpo JSON:

```json
{ "imagemBase64": "...", "mediaType": "image/jpeg" }
```

Devolve:

```json
{
  "tipoDocumento": "restaurante",
  "itens": [
    { "nome": "Bacalhau à Brás", "preco": 14.5, "quantidade": 1, "categoria": "comida" }
  ]
}
```
