-- 0275 · App Secret por número oficial — o segundo número pode vir de OUTRO app da Meta.
--
-- O App Secret que confere a assinatura do webhook era da INSTALAÇÃO
-- (`platform_meta_app`, 0257, uma linha só). Isso vale enquanto todo número
-- conectado entrega pelo MESMO app da Meta. Medido na primeira instalação com
-- dois números oficiais (2026-09-23): o segundo número está noutra WABA,
-- inscrita noutro app — e cada entrega dele chega assinada com o segredo desse
-- outro app. Com um segredo só, toda mensagem do segundo número morreria em
-- `401 invalid_signature`, calada: a Meta não mostra o motivo a ninguém.
--
-- A coluna é OPCIONAL e o vazio é o caso comum: sem ela, vale o segredo da
-- instalação, como sempre. A rota do webhook já resolve a sessão pelo token do
-- path ANTES de conferir a assinatura, então o segredo certo sai da própria
-- linha — nunca do corpo.
--
-- Cifrado pelas MESMAS RPCs do resto do repo (`fn_encrypt_oauth`), no mesmo
-- tipo de `meta_token_encrypted`. Nenhuma função nova, nenhum GRANT novo.
-- Idempotente; nenhuma constraint nova, nenhum dado a corrigir.

alter table public.channel_sessions
  add column if not exists meta_app_secret_encrypted bytea;

comment on column public.channel_sessions.meta_app_secret_encrypted is
  'App Secret do app da Meta pelo qual ESTE número entrega o webhook, cifrado por fn_encrypt_oauth. NULL = vale o da instalação (platform_meta_app). Existe para dois números de apps diferentes na mesma instalação (migration 0275).';

notify pgrst, 'reload schema';
