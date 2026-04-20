# CAMERAS-RSTP

Sistema web de monitoramento de cameras em Node.js com suporte a RTSP, HLS, autenticacao por sessao e gravacao local via FFmpeg.

## Requisitos

- Node.js 20+
- FFmpeg disponivel no PATH do sistema

## Como iniciar

```bash
npm install
npm start
```

Depois acesse `http://localhost:8085`.

## Login inicial

- Usuario: `admin`
- Senha: `admin123`

Altere a senha padrao apos o primeiro acesso.

## Estrutura de dados

O projeto usa arquivos JSON locais em `data/`:

- `cameras.json`: cameras cadastradas
- `users.json`: usuarios do sistema
- `settings.json`: configuracoes de gravacao

Os diretorios `hls/` e `records/` sao gerados em runtime e nao devem ser versionados.
