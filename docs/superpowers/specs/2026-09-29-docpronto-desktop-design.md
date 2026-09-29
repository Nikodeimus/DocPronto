# DOCPronto Desktop: desenho de arquitetura

## Objetivo

Transformar o DOCPronto em um aplicativo Windows rapido de abrir, simples de instalar e capaz de receber atualizacoes automaticas sem depender do Sites, do navegador aberto manualmente ou de comandos PowerShell executados pelo usuario.

O produto tera dois canais derivados do mesmo codigo-fonte:

- **DOCPronto Laboratorio:** ambiente interno para desenvolver, experimentar, diagnosticar e homologar mudancas.
- **DOCPronto:** aplicativo estavel distribuido a outras pessoas, atualizado somente com versoes aprovadas.

Licenciamento comercial, ativacao por chave e cobranca ficam explicitamente fora desta fase. A arquitetura nao deve impedir sua inclusao futura.

## Principios

1. Um unico codigo-fonte gera os dois canais; nao havera duas copias mantidas manualmente.
2. O usuario abre o aplicativo por um icone e nunca precisa executar comandos.
3. Alteracoes chegam ao canal estavel somente depois de testes, revisao e aprovacao.
4. Arquivos financeiros, documentos, senhas e chaves privadas permanecem no computador.
5. Falhas no Laboratorio devem ser explicaveis e reproduziveis sem registrar conteudo sensivel.
6. A versao estavel prioriza mensagens claras; detalhes tecnicos ficam em uma area avancada.

## Abordagem escolhida

Usar Electron para empacotar a interface existente e o servico local Node.js. Esta opcao preserva os conversores atuais, o acesso ao Microsoft Word e a integracao com certificados do Windows, ao mesmo tempo que inclui o runtime necessario no instalador.

Tauri foi descartado nesta fase porque exigiria reescrever ou manter um processo Node auxiliar. Manter apenas o servidor no navegador tambem foi descartado porque conservaria o problema de ciclo de vida e abertura manual.

## Estrutura do aplicativo

O repositorio atual passa a ser a fonte canonica do DOCPronto. A estrutura alvo separa responsabilidades:

- `desktop/main`: ciclo de vida Electron, janela, instancia unica, atualizacoes e inicializacao do servico.
- `desktop/preload`: ponte minima e tipada entre a interface e recursos Desktop autorizados.
- `desktop/service`: Word, certificados, assinatura e demais operacoes locais privilegiadas.
- `public/docpronto`: interface e conversores executados no renderer.
- `shared/diagnostics`: contratos de erros, eventos, redacao e exportacao de relatorios.
- `tests`: testes unitarios, integrados, de interface e de empacotamento.

O renderer tera `contextIsolation` ativo e `nodeIntegration` desativado. A interface nao recebera acesso generico ao sistema de arquivos, ao shell ou ao processo Node. Operacoes privilegiadas usarao uma API explicita no preload.

Durante a migracao, o servico HTTP local existente pode continuar encapsulado pelo processo principal para reduzir risco. Ele devera usar porta dinamica em `127.0.0.1`, token efemero por execucao e encerramento conjunto com o Electron. Depois da paridade funcional, endpoints internos poderao migrar para IPC tipado quando isso simplificar o sistema.

## Inicializacao e desempenho

O aplicativo usara bloqueio de instancia unica. Uma segunda abertura apenas traz a janela existente para frente.

A janela sera criada imediatamente e a interface estatica sera carregada antes das integracoes pesadas. OCR, descoberta de certificados, verificacao do Word e atualizador serao inicializados de forma adiada. A meta inicial e exibir uma janela utilizavel em ate 3 segundos em um computador Windows corporativo comum, sem bloquear a interface enquanto componentes opcionais carregam.

PowerShell podera continuar sendo usado internamente para Word e certificados, sempre oculto e iniciado pelo aplicativo. O usuario nao executara scripts nem vera janelas de terminal.

## Canais Laboratorio e Estavel

Os canais serao produtos instalaveis lado a lado:

| Propriedade | Laboratorio | Estavel |
|---|---|---|
| Nome | DOCPronto Laboratorio | DOCPronto |
| Identificador do aplicativo | proprio e exclusivo | proprio e exclusivo |
| Pasta de dados | separada | separada |
| Aparencia | selo visivel `LAB` | sem elementos de desenvolvimento |
| Diagnostico | completo | mensagem simples e detalhes avancados |
| Atualizacao | builds de homologacao | apenas releases aprovadas |
| Publico | equipe interna | usuarios finais |

As configuracoes, historico tecnico e cache de um canal nao serao compartilhados com o outro. Arquivos do usuario continuarao sendo escolhidos e salvos nos locais indicados pelo proprio usuario.

## Fluxo de entrega

O desenvolvimento ocorre no canal Laboratorio. Cada mudanca segue estes estados:

1. Implementacao no codigo-fonte canonico.
2. Testes automatizados e verificacoes locais.
3. Build do DOCPronto Laboratorio.
4. Homologacao com arquivos sinteticos ou amostras autorizadas.
5. Revisao de seguranca e regressao proporcional ao risco.
6. Aprovacao humana para promocao.
7. Geracao do instalador e portatil estaveis.
8. Publicacao da release e disponibilizacao pelo atualizador.

Uma edicao feita com o Codex nao sera enviada diretamente aos usuarios. Ela se torna atualizacao automatica somente depois que uma release aprovada for criada. Isso preserva a rapidez do processo sem transformar cada experimento em atualizacao de producao.

## Instalacao e formatos

O pipeline produzira:

- instalador Windows `.exe`, com atalhos no Desktop e menu Iniciar;
- executavel portatil para uso sem instalacao;
- build do Laboratorio instalavel lado a lado;
- metadados de atualizacao e hashes dos artefatos.

O instalador incluira Electron e Node.js. Microsoft Word continuara sendo requisito somente para conversoes que dependem dele. Certificados A3 continuarao dependendo do driver e token instalados no Windows.

Antes de distribuicao publica, o executavel e o instalador deverao receber assinatura de codigo de um certificado confiavel. Ate essa etapa, builds internos podem gerar alertas do Windows SmartScreen e devem ser tratados como artefatos de homologacao.

## Atualizacoes automaticas

O primeiro provedor sera GitHub Releases. O codigo-fonte pode permanecer privado; a estrategia final de hospedagem dos binarios sera configurada quando a distribuicao externa comecar.

O aplicativo estavel verificara atualizacoes apos a abertura sem atrasar a tela inicial. Downloads ocorrerao em segundo plano, com integridade verificada. A instalacao sera oferecida quando o pacote estiver pronto, permitindo concluir imediatamente ou ao fechar o aplicativo.

O Laboratorio recebera somente builds marcados para seu canal. Uma release de laboratorio nunca sera promovida automaticamente para usuarios estaveis.

Falhas de rede ou indisponibilidade do provedor nao impedirao o uso do aplicativo instalado. O atualizador nunca executara pacote sem metadados e verificacoes esperadas.

## Diagnostico do Laboratorio

Toda operacao importante emitira eventos estruturados com:

- identificador da execucao e codigo de erro;
- ferramenta e etapa atual;
- inicio, fim e duracao;
- resultado, aviso ou falha;
- mensagem amigavel em portugues;
- causa tecnica, stack trace e origem no codigo quando disponiveis;
- versoes do DOCPronto, Electron, Node.js, Windows e componentes relevantes;
- metadados nao sensiveis necessarios para reproducao.

O Laboratorio oferecera:

- painel de diagnostico com filtros por nivel, ferramenta e execucao;
- detalhes expansivos da falha;
- botoes para copiar o diagnostico e exportar um pacote ZIP;
- historico local limitado das ultimas execucoes;
- acao para repetir uma operacao ou etapa quando tecnicamente seguro;
- indicacao clara de arquivo, funcao e linha aproximada do codigo por meio de source maps do build de laboratorio.

O pacote de diagnostico contera manifesto, eventos em JSON, resumo legivel e informacoes de ambiente. Nao contera bytes dos documentos, texto extraido, senha de A1, PIN, chave privada, assinatura completa nem conteudo da area de transferencia. Nomes e caminhos de arquivos serao mascarados por padrao. A inclusao de uma amostra devera ser uma acao separada e consciente do operador.

Os registros terao limite de tamanho e retencao. O usuario podera apagar o historico a qualquer momento.

## Experiencia de erro na versao estavel

A versao estavel mostrara:

- o que nao foi concluido;
- uma explicacao curta;
- uma acao recomendada;
- um codigo de erro pesquisavel;
- acesso opcional aos detalhes tecnicos e exportacao redigida.

Erros de um arquivo em uma fila nao interromperao os demais quando a operacao permitir isolamento. Falhas destrutivas ou de integridade interromperao a operacao antes de salvar uma saida potencialmente incorreta.

## Seguranca e privacidade

- Toda superficie de rede local permanecera restrita a loopback.
- O renderer seguira politica de conteudo restritiva e nao executara codigo remoto.
- Navegacao externa sera bloqueada por padrao e links permitidos abrirao no navegador do sistema.
- APIs do preload serao enumeradas; nao havera ponte generica para `exec`, `spawn` ou sistema de arquivos.
- Atualizacoes serao aceitas somente do canal configurado e com verificacao de integridade.
- Segredos e documentos nao entrarao em logs.
- Diretorios temporarios serao removidos ao finalizar e tambem varridos de forma conservadora na inicializacao seguinte.
- Dependencias e artefatos de release passarao por auditoria antes da promocao estavel.

## Estrategia de testes

O trabalho seguira desenvolvimento orientado a testes. Cada novo comportamento tera um teste que falha antes da implementacao.

Camadas de verificacao:

1. **Unitarios:** canais, configuracao, redacao de logs, codigos de erro e contratos IPC.
2. **Integracao:** servico local, Word, certificados simulados, conversores e filas.
3. **Interface:** abertura, foco, progresso, erros, painel do Laboratorio e acessibilidade.
4. **Empacotamento:** instalador, portatil, atalhos, instancia unica e ausencia de terminal visivel.
5. **Atualizacao:** selecao correta de canal, manifesto, download interrompido, rollback de falha e modo offline.
6. **Regressao documental:** PDFs e documentos sinteticos, alem de amostras reais explicitamente autorizadas.

Certificados reais e documentos de clientes nao serao incluidos no repositorio nem em artefatos de CI.

Agentes poderao trabalhar em tarefas independentes, como revisao de seguranca, testes de empacotamento e verificacao de interface. Os resultados serao integrados somente depois de revisao no fluxo principal. Plugins serao escolhidos por pertinencia, nunca apenas para aumentar a quantidade de ferramentas usadas.

## Migracao da base atual

1. Tornar este repositorio a fonte canonica e preservar a interface mais recente.
2. Importar do aplicativo local atual apenas o servidor, testes e integracoes Windows que ainda nao existam aqui.
3. Cobrir a paridade atual com testes antes de mover responsabilidades.
4. Adicionar o casco Electron sem alterar resultados dos conversores.
5. Criar o canal Laboratorio e seu sistema de diagnostico.
6. Gerar instalador e portatil locais.
7. Adicionar atualizacao automatica e pipeline de releases.
8. Homologar o Laboratorio; somente depois gerar a primeira versao estavel.

Durante a migracao, a pasta local existente permanece como referencia e recuperacao. Ela nao sera apagada nem sobrescrita ate a nova aplicacao comprovar paridade.

## Criterios de conclusao desta fase

- DOCPronto abre por atalho sem terminal ou comando manual.
- Laboratorio e Estavel podem coexistir sem compartilhar configuracoes.
- Instalador e portatil funcionam em uma maquina Windows limpa compativel.
- Conversores, fila PDF para OFX, Word e assinaturas mantem a paridade aprovada.
- Laboratorio apresenta diagnosticos estruturados, exportaveis e redigidos.
- Estavel apresenta erros claros com codigo de suporte.
- Atualizacoes de cada canal nao atravessam para o outro.
- Uma release aprovada pode ser publicada e detectada automaticamente.
- Testes automatizados, smoke test empacotado e revisao de seguranca passam.

## Fora de escopo

- licenciamento, ativacao, pagamentos e bloqueio comercial;
- sincronizacao de documentos em nuvem;
- envio automatico de diagnosticos;
- suporte a macOS ou Linux;
- substituicao do Microsoft Word por um motor proprio;
- exposicao do servico local para outros computadores da rede.
