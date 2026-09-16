# DocPronto Hub

Interface fiscal publicada em `/hub` e preservada separadamente do conversor original.

## Fluxos disponíveis

- entrada manual, TXT e CSV de chaves;
- validação, deduplicação, lotes, pausa, retomada e falhas;
- documentos, auditoria e exportação;
- A1 por PFX ou certificado instalado;
- A3 por token/cartão no leitor;
- consulta oficial de NF-e e CT-e por NSU;
- armazenamento local do XML oficial recebido.

## Release do agente

A fonte de verdade é `agent-release.json`. A interface ativa é `app.js` e o único instalador ativo é `instalar-agente.cmd`.

O fluxo A3 valida primeiro a chave privada localmente, tenta o provedor Windows de 64 bits e usa 32 bits como fallback apenas quando a falha indica incompatibilidade de provedor. A consulta à SEFAZ permanece bloqueada enquanto esse teste não passar.

## Limites

- O agente e o teste real do A3 exigem Windows, middleware do fabricante, token/cartão e PIN.
- O PIN não é enviado ao site nem persistido.
- NFS-e municipal exige conectores próprios e não faz parte do serviço nacional NF-e/CT-e.
- XML reconstruído é demonstrativo; somente XML recebido da SEFAZ é tratado como oficial.

Execute `npm run validate` na raiz antes de publicar.
