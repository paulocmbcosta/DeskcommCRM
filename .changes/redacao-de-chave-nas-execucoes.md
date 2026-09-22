---
impacto: nada_mudou
secao: corrigido
titulo: IA › Execuções — chave de API ecoada pelo provedor passa a ser apagada da mensagem de erro
---

Quando um provedor de IA recusa uma chave e devolve essa chave de volta na
própria mensagem de erro, o sistema deveria apagar a chave antes de gravar a
mensagem na tela de IA › Execuções. A mensagem de erro do provedor passou a
ser gravada em IA › Execuções na versão 1.2.0, junto com uma limpeza que
devia apagar a chave e, por um defeito, nunca apagou nada. Ou seja: da 1.2.0
à 1.36.0, se um provedor ecoou a chave num erro, ela pode ter ficado visível
ali — se você viu uma chave nessa tela, troque-a. Antes da 1.2.0 a mensagem
não era gravada nessa tela.

Para conferir se ficou algo visível: em **IA › Execuções**, clique em "Ver só
as falhas" e abra "Mensagem técnica do provedor" em cada execução com erro,
procurando por um trecho que pareça uma chave de API.
