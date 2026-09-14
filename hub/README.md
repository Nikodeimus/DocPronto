# DocPronto Hub — MVP

Esta pasta contém a primeira versão funcional e demonstrável da plataforma de gestão PDF/XML, criada a partir dos quatro prompts mestres do projeto.

## O que funciona

- Entrada manual, TXT e CSV.
- Normalização, validação de 44 dígitos e dígito verificador.
- Deduplicação e reaproveitamento de documentos existentes.
- Lotes independentes, concorrência configurável, pausa, retomada e cancelamento.
- Processamento assíncrono simulado com checkpoints, retry e fila de falhas.
- Dashboard, histórico, documentos, detalhes, auditoria e configurações.
- Exportação CSV e geração de XML demonstrativo para download.
- Persistência no navegador por localStorage.
- Layout responsivo e interface em português do Brasil.

## Limites desta versão

FSist e DocPronto estão representados por adapters, mas não foram conectados a endpoints inventados. A integração real deve usar exclusivamente API, webhook ou fluxo oficialmente autorizado. O sistema não tenta contornar CAPTCHA, autenticação ou mecanismos anti-bot.

Os PDFs e XMLs atuais são demonstrativos. XML reconstruído é identificado como RECONSTRUCTED e nunca deve ser confundido com XML fiscal original.

## Próxima etapa de produção

Arquitetura self-hosted recomendada:

- Frontend: Next.js + TypeScript
- Backend: NestJS
- Banco: PostgreSQL
- Fila/cache: Redis + BullMQ
- Storage: filesystem dedicado ou MinIO
- Proxy: Nginx/Caddy
- Implantação: Docker Compose em Linux

Antes da integração real, são necessários os contratos/documentação oficiais do FSist e do serviço DocPronto, além da definição de autenticação, armazenamento, retenção e política LGPD.

## Acesso

No GitHub Pages, abra a rota /hub/ do projeto DocPronto.
