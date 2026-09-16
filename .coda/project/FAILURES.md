# Falhas e tentativas anteriores

## F-001 — Tratar certificado instalado como A1

Resultado: falhou para A3 porque a chave privada permanece no token e não é exportável.

Não repetir sem: confirmar o tipo efetivo e a política do provedor.

## F-002 — HttpWebRequest/GetRequestStream com A3

Resultado: travamentos e falhas de canal TLS antes da SEFAZ.

Não repetir sem: evidência de compatibilidade com o middleware específico.

## F-003 — Schannel/cURL com repositório Windows

Resultado: `SEC_E_UNKNOWN_CREDENTIALS` em drivers que não entregam a chave ao canal TLS.

Não repetir como solução universal.

## F-004 — Exportar A1 instalado em memória

Resultado: falha quando a chave foi instalada como não exportável; não se aplica a A3.

## F-005 — ComputeSignature com sobrecarga incompatível

Resultado: PowerShell 5.1 não aceitou a chamada de dois argumentos. A chamada compatível usa `ComputeSignature($signer)`.

## F-006 — Correções por versão paralela

Resultado: site, cache, instalador e agente ficaram em versões diferentes; surgiram branches divergentes e botões apontando para V19 enquanto a página anunciava V20.

Prevenção: fonte canônica, manifesto de release e teste automático de consistência.
