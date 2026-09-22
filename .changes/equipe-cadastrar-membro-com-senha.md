---
impacto: capacidade_nova
secao: adicionado
titulo: Equipe — cadastrar um membro já com senha, sem depender de e-mail
---

Em **Equipe › Adicionar membros**, a aba **Cadastrar com senha** (agora a primeira) cadastra
a pessoa na hora: nome, e-mail, senha e papel. Não há convite, link nem confirmação por
e-mail — a pessoa já entra com o e-mail e a senha que você definiu. O botão **Gerar senha**
cria uma senha fácil de ditar, e depois do cadastro a tela mostra endereço, e-mail e senha
com **Copiar dados de acesso**. A senha não fica guardada em lugar nenhum: copie na hora.

No menu de cada membro (aba **Membros**) há **Definir nova senha**, para quando alguém
esquece a senha — numa instalação sem envio de e-mail, "Esqueci a senha" não chega a lugar
nenhum. A senha anterior deixa de valer para novas entradas; quem já estiver conectado
pode continuar até sair (para tirar a pessoa na hora, use **Revogar acesso**).

Novo também: **Configurações › Perfil › Trocar senha**, para qualquer pessoa trocar a
própria senha logada, informando a atual. É o jeito de o membro ficar com uma senha que só
ele conhece.

O convite por e-mail continua na aba **Convidar por e-mail**, para quem prefere que a
pessoa escolha a própria senha. Sem e-mail configurado, a tela passa a dizer isso e a
apontar para o cadastro com senha.

Proteções, para instalações com mais de uma organização: o cadastro nunca troca a senha de
um e-mail que já tem conta no sistema; **Definir nova senha** não vale para quem também faz
parte de outra organização; e uma conta cuja senha foi definida por um administrador só
aceita convite de **outra** organização depois que a própria pessoa troca a senha. Quem
abriu uma organização para outra pessoa entrega o cargo de administrador por convite, não
por senha. Numa instalação com uma organização só, nada disso aparece.

A telemetria de erros passou a apagar senhas e segredos do corpo das requisições antes de
enviar qualquer evento.
