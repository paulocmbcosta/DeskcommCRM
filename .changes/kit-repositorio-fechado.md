---
impacto: capacidade_nova
secao: adicionado
titulo: O instalador e o atualizador funcionam com o repositório e as imagens privados
---

Quem mantém o próprio repositório fechado passa a conseguir instalar e
atualizar normalmente, desde que o servidor tenha as duas credenciais de
leitura: a chave de acesso ao código e o login no registro de imagens.

- **Na instalação**, o instalador usa o login do Docker do servidor para
  conferir as imagens. Sem o login, ele diz que as imagens existem mas o
  servidor não tem permissão — em vez de dizer que "ainda não foram
  publicadas" e mandar esperar por algo que esperar não resolve.
- **Na atualização**, quando o servidor não consegue consultar o repositório,
  a resposta deixa de ser "você já está na versão mais recente": passa a
  dizer que é a mais recente *que este servidor conhece*, e separa "o acesso
  foi recusado" de "sem internet".
- O atualizador não fica mais parado numa pergunta de usuário e senha quando
  falta a credencial.

Para quem usa o repositório público, nada muda. O passo a passo de fechar,
com a ordem que não derruba a atualização de ninguém, está em
`docs/runbooks/repositorio-fechado.md`.
