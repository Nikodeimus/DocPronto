# Mapa do projeto

## Navegação e módulos

```text
/
└── Conversor original

/hub/
├── Visão geral
├── Processamento em lote
├── Caixa de entrada
├── Documentos
├── Lotes
├── Falhas
├── Integrações
├── Certificados A1/A3
├── Administração
├── Auditoria
└── Configurações
```

## Fluxo fiscal crítico

```text
hub/app.js
→ http://127.0.0.1:4174
→ server-cert-v8.mjs
→ repositório de certificados do Windows
→ token/middleware A3 ou PFX A1
→ SEFAZ Distribuição DFe
→ XML original salvo localmente
→ documento registrado no Hub
```

## Contratos

- `GET /api/health`: versão, estado e capacidades.
- `GET /api/certificates`: certificados válidos com chave privada.
- `POST /api/certificate/test-a3`: valida certificado e assinatura local; não consulta SEFAZ.
- `POST /api/dfe/sync`: consulta NF-e ou CT-e por NSU.
- `POST /api/dfe/xml`: recupera XML oficial armazenado pelo agente.

## Limites

- GitHub Pages entrega apenas o frontend.
- Operações com certificado e Office dependem do agente Windows.
- NFS-e municipal não usa o serviço nacional de distribuição de NF-e/CT-e.
