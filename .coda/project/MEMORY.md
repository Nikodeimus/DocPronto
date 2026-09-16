# Memória do projeto

Última verificação: 2026-09-16

## Objetivo

O DocPronto reúne o conversor original e o Hub fiscal. O Hub preserva o conversor existente em `/` e opera isolado em `/hub`.

## Fontes de verdade

- Frontend do Hub: `hub/app.js`.
- Agente local: `server-cert-v8.mjs`.
- Release exigida: `hub/agent-release.json`.
- Instalador ativo: `hub/instalar-agente.cmd`.
- Validação: `npm run validate`.

## Invariantes

- A interface não consulta a SEFAZ com A3 antes da assinatura local passar.
- O PIN do A3 não entra no site nem é persistido.
- A1/PFX e senhas não são registrados em memória do projeto ou logs.
- O NSU é isolado por CNPJ e tipo de documento.
- XML oficial recebido da SEFAZ não é alterado.
- O instalador não encerra processos Node que não pertençam ao DocPronto.
- Operações locais exigem o código de pareamento gerado pelo instalador.
- Site, instalador, manifesto e agente devem usar a mesma release.

## Estado atual

Release alvo: `2026.09.16-cert.21`.

Validação real pendente: teste em Windows com o token/cartão A3 e middleware do fabricante. O ambiente Linux não possui o hardware nem PowerShell para confirmar essa etapa.
