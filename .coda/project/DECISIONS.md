# Decisões

## D-001 — Preservar o conversor e isolar o Hub

Status: ACTIVE

O conversor permanece na raiz e a plataforma fiscal em `/hub`, conforme decisão do produto. Não criar uma segunda aplicação paralela.

## D-002 — Uma release ativa do agente

Status: ACTIVE

`hub/agent-release.json` é o contrato de versão. A página usa `hub/app.js`, o download usa `hub/instalar-agente.cmd` e o agente executa a fonte canônica `server-cert-v8.mjs`.

Motivo: versões V9–V20 lado a lado produziram divergência entre cache, interface, instalador e processo local.

## D-003 — Gate local obrigatório para A3

Status: ACTIVE

A consulta fiscal só é habilitada após uma assinatura CMS local. A tentativa usa PowerShell 64 bits e, para falhas compatíveis de provedor/chave, repete em 32 bits.

## D-004 — Diagnóstico em etapas

Status: ACTIVE

Falhas devem informar etapa e código: agente, certificado, chave privada, conexão SEFAZ ou resposta fiscal. Mensagens genéricas não devem substituir evidência disponível.

## D-005 — Atualização local segura

Status: ACTIVE

O instalador valida SHA-256 e só encerra o processo que pertence ao diretório do DocPronto. Processo alheio na porta 4174 bloqueia a instalação.

## D-006 — Pareamento automático da sessão local

Status: ACTIVE

O instalador gera um código aleatório por execução, entrega o código ao processo local e abre o Hub com o valor no fragmento da URL. O agente rejeita chamadas sem o cabeçalho correspondente. O código não é enviado ao GitHub Pages.
