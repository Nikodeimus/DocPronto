# Changelog técnico

## 2026-09-16 — Agente V22

- corrigida a migração de agentes V7–V21 que já ocupavam a porta 4174;
- corrigida a geração do código de pareamento no `cmd`;
- download passa a ser validado antes de encerrar a versão anterior;
- falhas geram `instalacao.log` e abrem o diagnóstico no Bloco de Notas;
- processo canônico inicia com marcador próprio para atualizações futuras.

## 2026-09-16 — Diagnóstico e release canônica

- consolidado `hub/app.js` como frontend ativo;
- criado manifesto único de release;
- criado instalador canônico com hash e proteção de processo;
- adicionado pareamento automático entre Hub e agente local;
- adicionados códigos e etapas de diagnóstico do agente;
- adicionado fallback A3 64/32 bits com registro das tentativas;
- adicionados testes de sintaxe e consistência;
- inicializada memória C.O.D.A do projeto;
- preservado o conversor original e o Hub em `/hub`.
- corrigido o servidor local para resolver rotas de diretório como `/hub/`.
