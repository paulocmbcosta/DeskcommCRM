---
impacto: nada_mudou
secao: corrigido
titulo: Número oficial com token de um app e webhook de outro
---

Conectar um número da API Oficial informando a chave secreta do app falhava com
"Invalid appsecret_proof" quando o token tinha sido gerado em um app e o webhook
do número vinha de outro. A tela agora tem o campo "ID do app do webhook": com
ele, a chave é conferida direto com esse app.
