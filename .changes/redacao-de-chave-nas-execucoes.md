---
impacto: nada_mudou
secao: corrigido
titulo: IA › Execuções — chave de API ecoada pelo provedor passa a ser apagada da mensagem de erro
---

Quando um provedor de IA recusa uma chave e devolve essa chave de volta na
própria mensagem de erro, o sistema deveria apagar a chave antes de gravar a
mensagem na tela de IA › Execuções. Essa limpeza existe desde a versão 1.2.0,
mas tinha um defeito e nunca apagou nada — e nas versões anteriores à 1.2.0
não existia limpeza nenhuma. Ou seja: em QUALQUER versão já publicada deste
produto, se um provedor ecoou a chave num erro, ela podia ter ficado visível
na tela para qualquer pessoa com acesso de gerente na organização. Se você já
viu uma chave de API aparecer numa mensagem de erro em IA › Execuções, troque
essa chave junto ao provedor por segurança — independente da versão que você
está rodando.
