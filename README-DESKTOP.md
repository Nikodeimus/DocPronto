# DOCPronto Desktop

O DOCPronto Desktop executa a interface e o processamento local no Windows. Depois de instalado, ele abre pelo atalho da Area de Trabalho ou do menu Iniciar, sem PowerShell ou terminal visivel.

## Canais

- **DOCPronto Laboratorio:** ambiente de desenvolvimento e homologacao. Exibe o selo `LAB`, diagnosticos tecnicos redigidos e recebe apenas atualizacoes do canal `lab`.
- **DOCPronto Estavel:** aplicativo destinado a usuarios finais depois da homologacao. Usa dados e atualizacoes separados e nao exibe recursos exclusivos do Laboratorio.

Os dois aplicativos podem coexistir. Nunca promova um build do Laboratorio renomeando o executavel: gere e homologue o canal Estavel separadamente.

## Diagnosticos

No Laboratorio, abra **Diagnostico** na barra superior para filtrar eventos, ver codigo, ferramenta, etapa e causa, repetir operacoes elegiveis, limpar o historico ou **Exportar ZIP**. Os registros ficam em `%APPDATA%\DOCPronto-Laboratorio\diagnostics`; no Estavel, em `%APPDATA%\DOCPronto\diagnostics`.

O relatorio e redigido e nao deve conter documentos, texto extraido, senha, PIN, chave privada ou assinatura completa. Mesmo assim, revise o ZIP antes de compartilha-lo. O aplicativo nao envia diagnosticos automaticamente.

## Requisitos E Limites

- Windows x64 compativel com Electron 44.
- Word para PDF usa por padrão um motor visual próprio no dispositivo, reconstruindo o DOCX e renderizando cada página. O Microsoft Word é uma alternativa opcional para integrações locais específicas. Fontes ausentes, campos complexos, macros e recursos não suportados podem alterar o layout.
- PDF para Word usa reconstrução/OCR local para produzir texto editável. PDFs escaneados podem demorar, e colunas, tabelas, fontes, cabeçalhos e posicionamento podem exigir ajustes no DOCX resultante.
- A assinatura digital usa certificado disponivel no repositorio do Windows ou arquivo A1. Certificado ausente, expirado, sem chave privada ou sem driver pode impedir somente a assinatura.
- Assinatura visual nao equivale a assinatura digital certificada.
- Conversoes e OFX precisam ser conferidos antes de uso documental, bancario ou contabil.

## Desenvolvimento

```text
npm ci
npm run desktop:lab
npm run desktop:stable
npm run desktop:test
npm run desktop:verify
```

`desktop:verify` e o gate local unico: executa a suite web e Desktop, gera e inspeciona fisicamente LAB e Estavel e abre os dois executaveis reais para o smoke de interface, health, capacidades opcionais, instancia unica e encerramento. O smoke exige Windows e falha se o canal que sera testado ja estiver aberto. Cada amostra faz duas aberturas de preparacao e depois uma abertura oficial. O LAB exige tres amostras oficiais fixas e o Estavel uma; nenhuma amostra e repetida condicionalmente quando falha. O limite de 3 segundos começa imediatamente antes de cada `spawn` oficial e termina somente quando a janela esta mostrada e o renderer confirma, por IPC protegido depois de dois frames, que o DOM e o JavaScript principal foram efetivamente pintados.

As duas preparacoes reduzem a variacao de cache, antivirus e inspecao do executavel. Portanto, o limite de 3 segundos e um contrato de abertura aquecida do build homologado, demonstrado pelas tres amostras LAB, nao uma promessa sobre a primeira abertura em qualquer computador. A primeira preparacao representa melhor o comportamento frio e pode ser mais lenta; um EXE novo e sem Authenticode tambem pode aguardar uma decisao do SmartScreen. O relatorio preserva todos os tempos frios, aquecidos e oficiais para deixar essa diferenca visivel.

## Builds Locais

```text
npm run desktop:package:lab
npm run desktop:package:stable
```

O LAB gera instalador NSIS, portatil e pasta desempacotada em `release/lab`. O Estavel usa `release/stable`. Builds nao devem incluir `.env`, logs, testes, fixtures reais, Downloads ou arquivos de clientes.

## Releases E Atualizacoes

- Laboratorio: tag `lab-vX.Y.Z-lab.N`, versao `X.Y.Z-lab.N`, feed `lab`.
- Estavel: tag `vX.Y.Z`, versao `X.Y.Z`, feed `latest`.

O workflow publica metadados e binarios em **GitHub Releases** no repositorio configurado. Atualizacao automatica depende dessa hospedagem continuar disponivel e corretamente configurada; ficar offline ou remover uma release nao pode impedir a abertura do aplicativo.

## Assinatura Do Aplicativo

Os artefatos locais atuais de homologacao nao possuem assinatura Authenticode. O Windows SmartScreen pode exibir um aviso de editor desconhecido. Isso nao e uma garantia de malware nem uma garantia de seguranca: e a consequencia de o executavel nao ter uma identidade de editor validada pelo Windows.

Uma release Estavel publica deve ser gerada somente com certificado Authenticode, senha e `publisherName` configurados no ambiente protegido do CI. Nao armazene certificado ou senha no repositorio. A revisao Codex Security do diff completo e a homologacao manual com arquivos autorizados continuam obrigatorias antes da primeira promocao Estavel.
