# Audit log — racional e prova

> Movido do `CLAUDE.md` em 2026-09-15 (auditoria Prumo). A regra prática ficou
> lá, curta; o "por quê" e a prova ficam aqui.

## Por que auditar só quando houve efeito

`routing-worker` (1×/min) e `attendant-heartbeat` (1×/5min) auditavam
incondicionalmente: ~51.840 linhas/mês numa instalação que não atende ninguém,
e numa VPS real **95% do audit log** era batida de cron vazia
(`docs/testing/user-journey-map.md`, achado 17). A guarda certa é *auditar
quando houve efeito*, nunca *parar de auditar* — as duas direções são medidas
por `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`, que varre o AST de
**toda** rota de `app/api/v1/cron/`.

## Append-only é do schema, com uma ressalva

Nenhum papel tem GRANT de UPDATE/DELETE em `api_audit_log` — **nem
`service_role`**. Para conferir na fonte:

```bash
psql "$SUPABASE_DB_URL" -c "select grantee, privilege_type from information_schema.role_table_grants
  where table_name='api_audit_log' and privilege_type in ('DELETE','UPDATE','TRUNCATE');"
```

**`TRUNCATE` entra na consulta de propósito, e o resultado não é vazio.** Ele
está concedido a `anon`, `authenticated` e `service_role` — resíduo de o dump
enumerar os privilégios desta tabela (as demais recebem `GRANT ALL`, e quem as
protege é a RLS). Uma sonda que pergunte só por `DELETE`/`UPDATE` devolve zero
linhas e deixa quem leu concluindo que a tabela não pode ser esvaziada, quando
o privilégio que a esvazia INTEIRA está lá. Não é alcançável pela REST (o
PostgREST não emite `TRUNCATE`), então não é buraco de superfície — mas a
frase "append-only é do schema" só é inteira com esta ressalva escrita.

## Retenção: 5 anos default, e agora EXECUTADA

O expurgo é `public.fn_expurgar_auditoria_vencida` (`security definer`, **piso
de 90 dias dentro do corpo**, revogada de anon/authenticated), chamada em
lotes pelo cron `app/api/v1/cron/data-retention` (diário). O knob é
`AUDIT_LOG_RETENTION_DAYS`. **Não há camada cold/S3** — o "hot 90 dias, cold
(S3) o resto" que o `CLAUDE.md` afirmou por meses nunca existiu em código
(auditoria de 2026-08-14: zero ocorrência de arquivamento), e um self-host não
tem para onde arquivar: o Storage do cliente é a MESMA cota de 1 GB, já
dividida com `whatsapp-media`. Para ver o que está em vigor:
`grep -n "RETENCAO_AUDITORIA_DIAS" lib/retencao/politica.ts`.

## Por que a `security definer` de expurgo não é porta de adulteração

O argumento inteiro está no cabeçalho da migration 0167: ela **não tem seletor
de linha** — nenhum parâmetro de org, ator, ação ou id, e o único predicado é
`created_at < now() - N dias`; o piso mora **no corpo**, não em quem chama; não
é alcançável pela REST; não amplia o raio de quem já tem a service key; e
**registra a própria erosão** (`retention.sweep_run`, com a contagem, numa
linha nova demais para a chamada seguinte alcançar).
