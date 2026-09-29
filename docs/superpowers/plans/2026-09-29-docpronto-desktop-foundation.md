# DOCPronto Desktop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o DOCPronto como aplicativo Windows Electron nos canais Laboratorio e Estavel, com servico local incorporado, diagnostico seguro, instalador, portatil e atualizacao automatica.

**Architecture:** A interface estatica atual continua em `public/docpronto` e e aberta por uma janela Electron protegida. O processo principal inicia um servico HTTP efemero em loopback para servir a interface e executar Word/certificados, enquanto preload, diagnostico, canais e atualizador ficam em modulos pequenos e testaveis. O mesmo codigo gera dois produtos com identificadores, dados e feeds de atualizacao separados.

**Tech Stack:** Electron 44.4.5, Node.js >=22.13.0, electron-builder 26.15.3, electron-updater 6.8.9, JSZip 3.10.1, JavaScript ESM, node:test, PowerShell interno no Windows, GitHub Actions/Releases.

**Spec:** `docs/superpowers/specs/2026-09-29-docpronto-desktop-design.md`

## Global Constraints

- O usuario abre o aplicativo por icone; nenhum comando ou terminal fica visivel.
- O servico atende somente em `127.0.0.1`, usa porta dinamica e encerra com o Electron.
- `contextIsolation` fica ativo, `nodeIntegration` fica desativado e o preload nao expoe shell, spawn ou sistema de arquivos generico.
- Laboratorio e Estavel usam `appId`, nome, pasta de dados e canal de atualizacao diferentes.
- Documentos, texto extraido, senhas, PINs, chaves e assinaturas completas nunca entram em logs.
- A interface aparece antes de OCR, certificados, Word e atualizador serem inicializados.
- Microsoft Word continua opcional e necessario apenas para o motor atual; sua substituicao pertence a um plano posterior da Fase 2.
- O codigo-fonte canonico fica neste repositorio; a pasta local antiga permanece intacta ate a homologacao.
- Toda mudanca de comportamento segue Red-Green-Refactor e termina com um commit pequeno.

## Review Focus

- Porta padrao ocupada ou indisponivel: usar porta dinamica sem encerrar processos alheios e exibir erro diagnosticavel se o bind falhar.
- Segunda abertura simultanea: reutilizar a primeira instancia sem iniciar outro servico ou corromper dados.
- Computador offline ou release indisponivel: abrir normalmente e registrar somente um aviso de atualizacao.
- Excecao contendo caminhos, nomes, senhas ou base64: redigir antes de persistir ou exportar o diagnostico.
- Word, certificado ou driver ausente: manter a interface utilizavel e falhar apenas a ferramenta dependente com codigo e acao recomendada.

---

### Task 1: Servico local canonico e paridade Windows

**Files:**
- Create: `desktop/service/server.mjs`
- Create: `desktop/service/windows-capabilities.mjs`
- Create: `tests/desktop/service.test.mjs`
- Create: `tests/desktop/windows-capabilities.test.mjs`
- Reference only: `../server.mjs`
- Reference only: `public/docpronto/downloads/server.mjs`

**Interfaces:**
- Produces: `startDocProntoService(options) -> Promise<{ origin, port, close }>` em `desktop/service/server.mjs`.
- Produces: `listWindowsCertificates()`, `signWithWindowsCertificate(input)`, `signPdfWithWindowsCertificate(input)` e `convertOfficeDocument(input, target)` em `desktop/service/windows-capabilities.mjs`.
- Consumes: `assetsRoot`, `host = "127.0.0.1"`, `port = 0`, `sessionToken` opcional e `onDiagnostic(event)` opcional.

- [ ] **Step 1: Escrever os testes de contrato do servico**

Criar testes `binds_only_to_loopback_with_an_ephemeral_port`, `serves_health_and_static_assets`, `rejects_wrong_host_and_path_traversal` e `closes_without_leaking_the_listener`. Validar `origin` com `^http://127\.0\.0\.1:\d+$`, health `service: "DocPronto Desktop"` e que outra origem/Host recebe 403.

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test tests/desktop/service.test.mjs`

Expected: FAIL porque `desktop/service/server.mjs` ainda nao existe.

- [ ] **Step 3: Implementar o servidor minimo e seguro**

Implementar `startDocProntoService({ assetsRoot, host = "127.0.0.1", port = 0, sessionToken, onDiagnostic })`. Reaproveitar as validacoes de Host, origem, MIME, traversal e limites do servidor local antigo; servir somente os ativos permitidos de `public/docpronto`; retornar `close()` idempotente.

- [ ] **Step 4: Executar o teste do servico e confirmar GREEN**

Run: `node --test tests/desktop/service.test.mjs`

Expected: PASS, processo encerrado e porta liberada.

- [ ] **Step 5: Escrever os testes de capacidades Windows**

Testar rejeicao de extensao incorreta, limite de entrada, thumbprint invalido e indisponibilidade do Word/PowerShell por injecao de `runPowerShell`. Fixar os codigos `WORD_UNAVAILABLE`, `CERTIFICATE_NOT_FOUND`, `INVALID_CERTIFICATE` e `LOCAL_OPERATION_TIMEOUT`.

- [ ] **Step 6: Executar os testes e confirmar RED**

Run: `node --test tests/desktop/windows-capabilities.test.mjs`

Expected: FAIL porque o modulo e os codigos ainda nao existem.

- [ ] **Step 7: Migrar as capacidades locais aprovadas**

Extrair da aplicacao local antiga as rotinas de Word, certificados e assinatura PDF para `windows-capabilities.mjs`. Aceitar dependencias opcionais `{ runPowerShell, tempRoot, timeoutMs }`, ocultar processos PowerShell e preservar a remocao de temporarios em `finally`.

- [ ] **Step 8: Executar testes da tarefa e a regressao existente**

Run: `node --test tests/desktop/service.test.mjs tests/desktop/windows-capabilities.test.mjs tests/connector-security.test.mjs`

Expected: PASS sem processos ou diretorios temporarios restantes.

- [ ] **Step 9: Commit**

```bash
git add desktop/service tests/desktop
git commit -m "feat: add canonical desktop service"
```

### Task 2: Canais Laboratorio e Estavel

**Files:**
- Create: `desktop/config/channel.mjs`
- Create: `tests/desktop/channel.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `CHANNELS`, `normalizeChannel(value) -> "lab" | "stable"` e `getChannelConfig(channel)`.
- `getChannelConfig` retorna `{ channel, productName, appId, userDataName, updateChannel, isLab }`.

- [ ] **Step 1: Escrever os testes dos dois canais**

Fixar Estavel como `{ productName: "DOCPronto", appId: "br.com.docpronto.desktop", userDataName: "DOCPronto", updateChannel: "latest", isLab: false }` e Laboratorio como `{ productName: "DOCPronto Laboratorio", appId: "br.com.docpronto.desktop.lab", userDataName: "DOCPronto-Laboratorio", updateChannel: "lab", isLab: true }`. Entrada ausente usa `lab`; valor desconhecido lanca `INVALID_RELEASE_CHANNEL`.

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test tests/desktop/channel.test.mjs`

Expected: FAIL porque `channel.mjs` nao existe.

- [ ] **Step 3: Implementar a configuracao imutavel dos canais**

Implementar e congelar os objetos retornados. Adicionar ao `package.json` `main: "desktop/main.mjs"` e preservar os scripts Sites existentes ate a paridade Desktop estar concluida.

- [ ] **Step 4: Executar o teste e confirmar GREEN**

Run: `node --test tests/desktop/channel.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/config tests/desktop/channel.test.mjs package.json
git commit -m "feat: define lab and stable channels"
```

### Task 3: Nucleo de diagnostico seguro

**Files:**
- Create: `desktop/diagnostics/events.mjs`
- Create: `desktop/diagnostics/redact.mjs`
- Create: `desktop/diagnostics/store.mjs`
- Create: `desktop/diagnostics/export.mjs`
- Create: `tests/desktop/diagnostics.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `createDiagnosticEvent(input)`, `redactDiagnosticValue(value)`, `DiagnosticStore`, `exportDiagnosticBundle({ events, environment, destination })`.
- `DiagnosticStore` expoe `append(event)`, `list(filters)`, `clear()` e `close()`.
- Consumes: eventos `{ level, tool, stage, code, message, technical, durationMs, metadata }`.

- [ ] **Step 1: Escrever testes de evento, retencao e redacao**

Testar IDs unicos, horario ISO, niveis permitidos, limite de 2.000 eventos e filtros. Incluir segredos em campos aninhados: `password`, `pin`, `contentBase64`, `signatureBase64`, caminho `C:\\Users\\Maria\\Documents\\FATURA-123.pdf` e stack trace; esperar `[REDACTED]` e nomes/caminhos mascarados.

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test tests/desktop/diagnostics.test.mjs`

Expected: FAIL porque os modulos nao existem.

- [ ] **Step 3: Implementar eventos e redacao antes da persistencia**

Implementar `createDiagnosticEvent` com schema fechado e `redactDiagnosticValue` recursivo. O store deve gravar JSONL atomicamente em `userData/diagnostics`, rotacionar em 5 MB e manter no maximo cinco arquivos.

- [ ] **Step 4: Instalar JSZip e implementar exportacao**

Run: `npm install --save-exact jszip@3.10.1`

Criar ZIP com `manifest.json`, `events.json` e `summary.txt`; redigir novamente na exportacao. Nunca aceitar bytes de documento como parte da API.

- [ ] **Step 5: Executar testes e confirmar GREEN**

Run: `node --test tests/desktop/diagnostics.test.mjs`

Expected: PASS e ZIP legivel sem os valores secretos usados pelo teste.

- [ ] **Step 6: Commit**

```bash
git add desktop/diagnostics tests/desktop/diagnostics.test.mjs package.json package-lock.json
git commit -m "feat: add redacted laboratory diagnostics"
```

### Task 4: Casco Electron e ciclo de vida rapido

**Files:**
- Create: `desktop/runtime.mjs`
- Create: `desktop/window.mjs`
- Create: `desktop/preload.mjs`
- Create: `desktop/main.mjs`
- Create: `tests/desktop/runtime.test.mjs`
- Create: `tests/desktop/window-security.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `createDesktopRuntime(deps)`, `createMainWindow({ BrowserWindow, origin, preloadPath, channelConfig })` e preload `window.docprontoDesktop`.
- Preload expoe somente `getAppInfo()`, `diagnostics.list(filters)`, `diagnostics.clear()`, `diagnostics.export()` e `diagnostics.record(event)`.
- Consumes: Task 1 `startDocProntoService`, Task 2 `getChannelConfig`, Task 3 `DiagnosticStore`.

- [ ] **Step 1: Escrever testes do runtime e instancia unica**

Com adaptadores Electron falsos, testar: lock negado chama `quit`; lock aceito inicia exatamente um servico; `second-instance` restaura/foca a janela; `before-quit` fecha store e servico uma vez; falha do Word nao impede a janela; bind impossivel gera evento `DESKTOP_SERVICE_START_FAILED`.

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test tests/desktop/runtime.test.mjs`

Expected: FAIL porque o runtime nao existe.

- [ ] **Step 3: Implementar o runtime por injecao de dependencias**

Implementar `createDesktopRuntime({ app, BrowserWindow, ipcMain, shell, startService, createStore, updateManager, channel })`. Configurar `userData` com `channelConfig.userDataName` antes de criar store ou janela. Carregar a janela assim que o health do servico responder; inicializar atualizador e capacidades opcionais depois de `ready-to-show`.

- [ ] **Step 4: Escrever o teste de seguranca da janela e preload**

Validar `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, bloqueio de `window.open`, bloqueio de navegacao fora de `origin` e ausencia de APIs genericas `exec`, `spawn`, `readFile` e `writeFile` no preload.

- [ ] **Step 5: Executar o teste e confirmar RED**

Run: `node --test tests/desktop/window-security.test.mjs`

Expected: FAIL ate `window.mjs` e `preload.mjs` existirem.

- [ ] **Step 6: Implementar janela, preload e entrypoint**

Criar janela minima 1120x760, minimo 900x640, fundo `#f5f3eb` e sem menu de aplicacao. Links externos permitidos usam `shell.openExternal` somente para `https:`; todas as demais navegacoes externas sao canceladas. `main.mjs` apenas conecta dependencias reais e chama o runtime.

- [ ] **Step 7: Instalar dependencias Electron e adicionar scripts**

Run: `npm install --save-dev --save-exact electron@44.4.5 electron-builder@26.15.3 && npm install --save-exact electron-updater@6.8.9`

Adicionar `desktop:lab`, `desktop:stable`, `desktop:test` e `desktop:dev` usando um script Node multiplataforma, sem sintaxe de variavel de ambiente exclusiva de Unix.

- [ ] **Step 8: Executar testes e confirmar GREEN**

Run: `npm run desktop:test`

Expected: todos os testes `tests/desktop/*.test.mjs` passam sem abrir janela real.

- [ ] **Step 9: Commit**

```bash
git add desktop tests/desktop package.json package-lock.json
git commit -m "feat: add secure Electron runtime"
```

### Task 5: Experiencia do Laboratorio e painel de diagnostico

**Files:**
- Create: `tests/desktop/lab-ui.test.mjs`
- Modify: `public/docpronto/index.html`
- Modify: `public/docpronto/app.js`
- Modify: `public/docpronto/styles.css`

**Interfaces:**
- Consumes: preload `window.docprontoDesktop` da Task 4.
- Produces: selo `LAB`, painel `#diagnosticsPanel`, lista filtravel, detalhes, copiar, exportar, limpar e repetir quando o evento declarar `retryable: true`.

- [ ] **Step 1: Escrever testes da UI Laboratorio/Estavel**

Testar que `applyDesktopChannel({ isLab: true })` mostra selo e controles; Estavel os oculta; evento tecnico renderiza codigo, ferramenta, etapa, causa e local; mensagem estavel mostra somente resumo, acao e codigo; Esc fecha painel e foco retorna ao botao que o abriu.

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test tests/desktop/lab-ui.test.mjs`

Expected: FAIL porque os elementos e funcoes ainda nao existem.

- [ ] **Step 3: Implementar integracao progressiva com o Desktop**

Quando `window.docprontoDesktop` nao existir, manter o comportamento web atual. Quando existir, obter canal e versoes, registrar `error`/`unhandledrejection` de forma redigida e publicar eventos de inicio, progresso e fim das ferramentas sem incluir conteudo do arquivo.

- [ ] **Step 4: Implementar painel acessivel e estilos**

Usar `dialog.showModal()`, `aria-modal`, foco preso, Esc, retorno de foco e tabela/lista responsiva. O selo `LAB` deve permanecer visivel na barra superior e nao depender apenas de cor.

- [ ] **Step 5: Executar testes de UI e regressao**

Run: `node --test tests/desktop/lab-ui.test.mjs tests/pdf-ofx-queue.test.mjs tests/tool-discovery.test.mjs`

Expected: PASS sem alterar os fluxos existentes.

- [ ] **Step 6: Commit**

```bash
git add public/docpronto tests/desktop/lab-ui.test.mjs
git commit -m "feat: add laboratory diagnostics interface"
```

### Task 6: Instalador, portatil e identidade dos dois produtos

**Files:**
- Create: `electron-builder.config.cjs`
- Create: `scripts/desktop-command.mjs`
- Create: `scripts/build-desktop.mjs`
- Create: `build/icon.ico`
- Create: `build/icon-lab.ico`
- Create: `tests/desktop/packaging.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `resolveBuilderConfig(channel, projectDir)` e CLI `node scripts/build-desktop.mjs --channel <lab|stable> [--dir]`.
- Consumes: Task 2 `getChannelConfig` e entrypoint da Task 4.

- [ ] **Step 1: Escrever testes da configuracao de empacotamento**

Testar `appId`, `productName`, nome de artefato, icone, `asar: true`, `asarUnpack` somente para recursos que precisem, alvo NSIS e portable, exclusao de `.env*`, testes, backups, logs e fontes Sites. Confirmar que o pacote inclui apenas `desktop/**`, `public/docpronto/**`, `package.json` e dependencias de runtime.

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test tests/desktop/packaging.test.mjs`

Expected: FAIL porque a configuracao nao existe.

- [ ] **Step 3: Implementar configuracao e comandos de build**

`scripts/desktop-command.mjs` define `DOCPRONTO_CHANNEL` e inicia Electron sem comandos PowerShell. `build-desktop.mjs` valida canal, executa a suite Desktop e chama electron-builder. NSIS cria atalhos no Desktop e menu Iniciar; portable grava configuracao na pasta do usuario, nunca ao lado do executavel.

- [ ] **Step 4: Criar icones distintos**

Gerar `icon.ico` a partir da marca atual e `icon-lab.ico` com selo LAB legivel em 16, 32, 48, 128 e 256 px. Verificar visualmente fundo transparente, bordas e leitura em tema claro/escuro.

- [ ] **Step 5: Executar teste e builds de diretorio**

Run: `node --test tests/desktop/packaging.test.mjs && node scripts/build-desktop.mjs --channel lab --dir && node scripts/build-desktop.mjs --channel stable --dir`

Expected: PASS e duas pastas desempacotadas com nomes, appIds e userData distintos.

- [ ] **Step 6: Gerar e inspecionar instalador e portatil do Laboratorio**

Run: `node scripts/build-desktop.mjs --channel lab`

Expected: um instalador NSIS e um portatil em `release/lab/`, sem console visivel ao abrir.

- [ ] **Step 7: Commit**

```bash
git add electron-builder.config.cjs scripts build tests/desktop/packaging.test.mjs package.json package-lock.json .gitignore
git commit -m "feat: package lab and stable desktop apps"
```

### Task 7: Atualizador por canal e modo offline

**Files:**
- Create: `desktop/update/manager.mjs`
- Create: `tests/desktop/update-manager.test.mjs`
- Create: `.github/workflows/desktop-release.yml`
- Modify: `desktop/runtime.mjs`
- Modify: `electron-builder.config.cjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createUpdateManager({ autoUpdater, channelConfig, diagnostics, appVersion })` com `start()`, `download()`, `installOnQuit()` e `dispose()`.
- Consumes: Task 2 `channelConfig.updateChannel` e Task 3 diagnostico.

- [ ] **Step 1: Escrever testes do atualizador**

Testar: verificacao ocorre depois do evento `ready-to-show`; offline gera warning `UPDATE_CHECK_UNAVAILABLE` sem rejeitar `start`; canal `lab` nunca aceita `latest`; canal `latest` nunca aceita prerelease Lab; hash/assinatura invalida gera `UPDATE_INTEGRITY_FAILED`; download concluido nao instala sem escolha ou fechamento.

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test tests/desktop/update-manager.test.mjs`

Expected: FAIL porque o manager nao existe.

- [ ] **Step 3: Implementar adaptador do electron-updater**

Configurar `autoDownload: false`, `autoInstallOnAppQuit: true` e canal exato da Task 2. Converter eventos do updater em diagnosticos redigidos e nunca bloquear a inicializacao por falha de rede.

- [ ] **Step 4: Executar testes e confirmar GREEN**

Run: `node --test tests/desktop/update-manager.test.mjs tests/desktop/runtime.test.mjs`

Expected: PASS.

- [ ] **Step 5: Criar pipeline de releases**

Workflow Windows: `lab-v*` gera prerelease Laboratorio; `v*` gera release Estavel. Executar `npm ci`, `npm test`, `npm run desktop:test`, build do canal correspondente, hashes SHA-256 e upload dos artefatos/metadados usando `GITHUB_TOKEN`. Nunca publicar ambos os canais pela mesma tag.

- [ ] **Step 6: Validar workflow e metadados localmente**

Run: `node --test tests/desktop/packaging.test.mjs tests/desktop/update-manager.test.mjs`

Expected: testes confirmam padroes de tag, canal e arquivos esperados.

- [ ] **Step 7: Commit**

```bash
git add desktop/update desktop/runtime.mjs tests/desktop/update-manager.test.mjs .github/workflows/desktop-release.yml electron-builder.config.cjs package.json
git commit -m "feat: add channel-aware desktop updates"
```

### Task 8: Smoke test empacotado, documentacao e gate de seguranca

**Files:**
- Create: `scripts/smoke-desktop.mjs`
- Create: `tests/desktop/release-contract.test.mjs`
- Create: `README-DESKTOP.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run desktop:verify` como gate unico para testes, build Lab desempacotado e smoke test.
- Consumes: todos os artefatos das Tasks 1-7.

- [ ] **Step 1: Escrever teste do contrato de release**

Testar que o gate inclui suite existente e Desktop, que artefatos Estavel nao contem `LAB`, que nenhuma `.env`, log, fixture real ou arquivo de Downloads entra no pacote e que health/version/canal correspondem ao executavel.

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test tests/desktop/release-contract.test.mjs`

Expected: FAIL porque gate e smoke script nao existem.

- [ ] **Step 3: Implementar smoke test do aplicativo empacotado**

Iniciar o build desempacotado com `DOCPRONTO_SMOKE=1`, exigir sinal de interface utilizavel em ate 3 segundos e aguardar health por no maximo 15 segundos, abrir segunda instancia e confirmar reaproveitamento, encerrar e confirmar liberacao da porta e ausencia de processo filho. Em ambiente sem Word/certificado, confirmar apenas os codigos esperados e que a janela continua aberta.

- [ ] **Step 4: Documentar uso e promocao**

`README-DESKTOP.md` deve explicar: abrir pelo icone; diferenca Lab/Estavel; onde ficam diagnosticos; como exportar relatorio; comandos de desenvolvimento; como gerar builds; tags de release; requisitos Word/certificado; ausencia atual de assinatura de codigo e consequencia no SmartScreen.

- [ ] **Step 5: Executar verificacao completa**

Run: `npm run desktop:verify`

Expected: suite atual, suite Desktop, build Lab e smoke test passam; nenhum terminal fica visivel.

- [ ] **Step 6: Executar revisao de seguranca**

Aplicar o plugin Codex Security ao diff completo. Corrigir achados validos de severidade alta ou critica com novo ciclo TDD; registrar riscos aceitos de assinatura de codigo e hospedagem de releases sem inventar garantias.

- [ ] **Step 7: Homologar com arquivos autorizados**

Executar Word para PDF, PDF para Word, assinatura visual, certificado instalado e fila de tres PDFs para OFX no Laboratorio. Exportar o diagnostico de uma falha induzida e confirmar manualmente que nao contem conteudo, senha, PIN ou caminho pessoal.

- [ ] **Step 8: Commit**

```bash
git add scripts/smoke-desktop.mjs tests/desktop/release-contract.test.mjs README-DESKTOP.md package.json
git commit -m "test: add desktop release verification gate"
```

### Task 9: Primeira promocao controlada

**Files:**
- Modify: `package.json`
- Modify: `README-DESKTOP.md`

**Interfaces:**
- Produces: versao Laboratorio instalavel e checklist preenchido; nao publica Estavel sem aprovacao humana.
- Consumes: `npm run desktop:verify` e workflow da Task 7.

- [ ] **Step 1: Atualizar a versao inicial Desktop**

Definir `version: "0.2.0-lab.1"` para a primeira homologacao e registrar no README as mudancas e limitacoes conhecidas.

- [ ] **Step 2: Executar o gate final novamente**

Run: `npm run desktop:verify`

Expected: PASS completo no commit exato que sera marcado.

- [ ] **Step 3: Criar tag apenas depois de publicar o repositorio GitHub**

Run: `git tag -a lab-v0.2.0-lab.1 -m "DOCPronto Laboratorio 0.2.0-lab.1"`

Expected: workflow produz prerelease Laboratorio; nenhuma release Estavel e criada.

- [ ] **Step 4: Instalar e homologar a prerelease em Windows**

Confirmar atalhos, abertura sem console, coexistencia com a aplicacao local antiga, painel detalhado, conversores e desinstalacao. Registrar o resultado no README sem incluir dados pessoais.

- [ ] **Step 5: Solicitar aprovacao para o primeiro Estavel**

Somente depois da homologacao, trocar para versao sem sufixo, executar o gate outra vez e criar tag `vX.Y.Z`. A criacao dessa tag exige aprovacao humana explicita e nao faz parte automatica desta tarefa.
