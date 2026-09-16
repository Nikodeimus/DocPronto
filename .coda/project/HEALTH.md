# Saúde do projeto

## Confirmado e tratado

- P0: divergência de release entre página, frontend, instalador e agente.
- P0: instalador podia encerrar qualquer processo Node na porta 4174.
- P1: teste A3 sem diagnóstico estruturado de etapa/arquitetura.
- P1: ausência de testes automatizados de consistência da publicação.
- P1: ausência de memória arquitetural e de tentativas falhas.
- P0: API local aceitava operações sensíveis sem pareamento exclusivo com a sessão do Hub.

## Confirmado e pendente

- P1: frontend do Hub permanece monolítico e deverá ser modularizado em tarefa separada, com testes de comportamento.
- P1: agente local reúne conversão Office, assinatura PDF e fiscal em um arquivo grande; separar sem teste Windows aumentaria o risco agora.
- P1: arquivos históricos V7–V20 ainda existem no Git e não são fontes ativas. Remoção deve ocorrer após a release canônica ser validada em produção.
- P1: XML reconstruído é demonstrativo e não substitui documento oficial da SEFAZ.

## Não validado neste ambiente

- middleware e janela de PIN do token A3;
- assinatura real 64/32 bits;
- handshake mTLS com a SEFAZ;
- resposta e distribuição por NSU em produção.
