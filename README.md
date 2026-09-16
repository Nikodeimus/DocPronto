# DocPronto

Suíte web de processamento de documentos com um Hub fiscal publicado em `hub/` e um agente local Windows para operações que exigem certificados A1/A3, Microsoft Office ou acesso seguro à SEFAZ.

## Fontes ativas

- `index.html`, `app.js`, `styles.css`: conversor original.
- `hub/index.html`, `hub/app.js`, `hub/styles.css`: Hub fiscal.
- `server.mjs`: servidor local do conversor.
- `server-cert-v8.mjs`: fonte canônica do agente local Windows.
- `hub/agent-release.json`: versão e hash exigidos pela interface.
- `hub/instalar-agente.cmd`: único instalador ativo.

## Validação

```bash
npm run validate
```

O teste real do A3 exige Windows, token/cartão, middleware do fabricante e PIN. A validação local do repositório confirma sintaxe, contratos de release, gate do A3, fallback 64/32 bits e segurança do atualizador.

Leia `CODA.md` antes de alterar o projeto. O mapa e as decisões atuais ficam em `.coda/project/`.
