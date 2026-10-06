-- 0294 — telefonia: o instante do primeiro toque na ligação FEITA.
--
-- Spec: docs/specs/20-spec-telefonia-sip.md §4.2.
--
-- A ligação feita que ninguém atendia virava "Ligação sem resposta" na conversa,
-- e o registro era o MESMO para quem deixou o telefone do cliente chamar até a
-- rede desistir e para quem deu um toque e desligou. O dono da operação não
-- tinha como separar as duas, e o toque servia de "tentei ligar". A saída que ele
-- achou — mandar a equipe deixar chamar até cair na caixa postal, que vira uma
-- "Ligação feita" com gravação — depende de o cliente TER caixa postal, custa uma
-- ligação completada na operadora e infla as ligações atendidas.
--
-- O que faltava era um fato: QUANDO o telefone do cliente começou a chamar.
-- `started_at` é o instante do pedido (o clique em "Ligar"), que inclui a rede
-- completando; `end_reason` já diz quem encerrou (`atendente_desligou` ou
-- `sem_resposta_<causa>`).
--
-- `voice_calls.peer_ringing_at`: o instante do primeiro `180 Ringing` ou
-- `183 Session Progress` da operadora na ligação de saída. Quem escreve é o
-- worker, na MESMA escrita que fecha a ligação (`encerrarLigacao`,
-- lib/channels/telefonia/repositorio.ts): ele guarda o instante na memória e
-- entrega "há quanto tempo foi"; o banco grava `now()` menos esse tempo, então
-- `ended_at - peer_ringing_at` é exatamente o que o worker mediu, mesmo com o
-- relógio da VPS e o do banco fora de sincronia. NULL = o telefone não chegou a
-- chamar, ou a ligação é de antes desta migration.
--
-- Quem lê: `registrarNaConversa`, que projeta o tempo no registro da conversa
-- (`messages.metadata.voice_call.toque_ms`) da feita NÃO atendida — e o cartão da
-- ligação o mostra embaixo do selo, com quem encerrou.
--
-- Só na linha do TELEFONE (`provider = 'sip_trunk'`), pela mesma regra da URA
-- (0288) e da gravação (0289): a linha do WaCalls a REST escreve com o JWT do
-- agent, e ninguém forja por ela um toque que não houve. A linha do telefone é
-- só-leitura pela REST desde a 0288.
--
-- Idempotente e auto-curativa: coluna com `if not exists`; o CHECK só quando
-- falta, com a linha fora da regra (só possível com o CHECK derrubado à mão)
-- curada ANTES; NOT VALID + validação, porque `voice_calls` cresce com o
-- histórico. Sem backfill: das ligações anteriores ninguém mediu o toque.
-- Nenhuma função, GRANT ou policy nova.

alter table public.voice_calls
  add column if not exists peer_ringing_at timestamptz;

do $chk_toque$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass
                    and conname = 'voice_calls_peer_ringing_so_no_telefone_check') then
    update public.voice_calls set peer_ringing_at = null
     where provider <> 'sip_trunk' and peer_ringing_at is not null;
    alter table public.voice_calls add constraint voice_calls_peer_ringing_so_no_telefone_check
      check (provider = 'sip_trunk' or peer_ringing_at is null) not valid;
  end if;
end $chk_toque$;

alter table public.voice_calls validate constraint voice_calls_peer_ringing_so_no_telefone_check;

comment on column public.voice_calls.peer_ringing_at is
  'Ligação FEITA: quando o telefone do cliente começou a chamar (o primeiro 180/183 da operadora). Gravado pelo worker na escrita que fecha a ligação, no relógio do banco: ended_at - peer_ringing_at é o tempo que o telefone chamou. NULL = não chamou, ou ligação anterior à 0294. Só sip_trunk. A projeção para a tela fica em messages.metadata.voice_call.toque_ms (só a feita não atendida).';

notify pgrst, 'reload schema';
