# CLAUDE.md — DeskcommCRM

> Instruções pra futuras sessões Claude trabalhando neste repo. Leitura obrigatória antes de qualquer task de código.

**Este arquivo é a doutrina — a autoridade final sobre convenção e anti-pattern.** Complementos, na ordem em que ajudam:

- [`AGENTS.md`](AGENTS.md) — mesmo contrato em forma portável (para Codex/Cursor/Copilot e afins). É derivado deste arquivo, não o substitui. **Ao mudar doutrina aqui, verifique se `AGENTS.md` desatualizou.**
- [`docs/index.md`](docs/index.md) — índice dos 149 docs, com regra de precedência quando dois docs discordam. Use antes de sair varrendo `docs/`.
- [`docs/current-state.md`](docs/current-state.md) — o que está pronto, incompleto e quebrado. **Leia antes de estimar ou prometer qualquer coisa.**
- [`docs/harness-audit.md`](docs/harness-audit.md) — onde a verificação tem buraco. Importante: `pnpm gov:verify` **não** cobre `test:db` nem `test:e2e` — verde ali não é prova para mudança de schema ou de UI.
- [`docs/threat-model.md`](docs/threat-model.md) — superfície de ataque real do self-host.

---

## Visão (1 parágrafo)

DeskcommCRM é um sistema operacional de vendas open source com agentes de IA nativos — multi-nicho (e-commerce, clínicas, imobiliárias, infoprodutos, serviços), com WhatsApp como canal primário (via WAHA). Agentes com RAG por tenant atendem, qualificam e movem o funil junto com humanos; CRM inteiro exposto via MCP. Monetização = self-host em VPS (parceria HostGator), não assinatura. Arquitetura multi-tenant com RLS desde o dia 1; LGPD nativa. Posicionamento completo: `VISION.md`.

---

## Stack canônica

- **Frontend:** Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito + Tailwind + shadcn/ui (style: `new-york`, neutral)
- **Backend:** Next.js Route Handlers (mesmo repo); workers via `event_log` table + cron
- **DB:** Supabase (Postgres). RLS em toda tabela tenant-aware. Extensions: `uuid-ossp`, `pgcrypto`, `vector`
- **Auth:** Supabase Auth via `@supabase/ssr`. Cookie SameSite=Strict, HttpOnly, Secure
- **Realtime:** Supabase Realtime (postgres_changes + broadcast)
- **Storage:** Supabase Storage (bucket `whatsapp-media` privado, URLs assinadas)
- **WhatsApp:** WAHA Plus, engine NOWEB
- **Filas/eventos:** `event_log` table + workers (não usar Inngest/Trigger no MVP)
- **Rate limit:** Upstash Redis sliding window
- **AI:** Vercel AI Gateway (Anthropic primário; OpenAI backup pra embeddings); strings tipo `"anthropic/claude-sonnet-4-6"`
- **Validação:** Zod em todo input externo (request body, webhook payload, env)
- **Observability:** Sentry com `beforeSend` sanitizado

---

## Convenções críticas (NÃO NEGOCIÁVEIS)

### Multi-tenancy
- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware
- RLS policy `tenant_isolation_<tabela>_all` aplicada via helper `fn_user_org_ids()`
- Service role bypassa RLS — handlers que usam admin client **DEVEM** filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **NUNCA do body**
- Toda query que cruza tabelas tenant-aware filtra `organization_id` explicitamente
- Teste de isolamento (cria 2 tenants, verifica não-vazamento) é obrigatório no CI antes de merge

### Idempotência & event sourcing leve
- Mensagens WhatsApp e eventos externos: `unique (organization_id, external_id)` + captura `code === '23505'` no INSERT
- POSTs de criação na API aceitam header `Idempotency-Key: <uuid>` (TTL 24h via Upstash)
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker (cron / Realtime listener) consome e dispara side effect

### API REST `/api/v1/`
- Versionamento por path. JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro em `_cents` + `currency` ISO-4217
- Wrapper sucesso: `{ data, meta?: { cursor, has_more, total } }`
- Wrapper erro: `{ error: { code, message, details? } }` — usar helpers `ok()` / `fail()` de `lib/api/wrappers.ts`
- Paginação: cursor opaco base64+HMAC por default
- Auth dual: cookie session (frontend) OU `Authorization: Bearer tok_...` (server-to-server)
- **API key NUNCA em query string** (vaza em logs Vercel/CF). Sempre header
- Plaintext de bearer token mostrado **uma vez** na criação; depois apenas hash SHA256 no DB
- Rate limit headers: `X-RateLimit-*` + `Retry-After` em 429
- `X-Request-Id` em toda response (correlaciona com audit log)

### Auth & RBAC
- Sempre `getUser()` (valida JWT no backend). NUNCA `getSession()` (confia no cookie local)
- 4 roles dentro do tenant: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4)
- Super-admin de plataforma é uma role transversal — `is_platform_admin` (decisão final na Spec 01)
- MFA TOTP é **opcional e ligado por quem administra**, não forçado por papel. Duas políticas independentes que SOMAM: `platform_admins.mfa_required` (super-admin) e `organizations.settings.security.mfa_required` (admin do tenant) — default de ambas é não exigir. Regra pura em `lib/auth/politica-mfa.ts` (motivo da mudança: `install.sh` cria o dono como platform admin, então o gate antigo bloqueava toda instalação self-host logo após onboarding sem aviso)
  - **⚠️ CADASTRAR e PROVAR são perguntas diferentes.** A política decide o cadastro; `mfaEmDivida()` (403 `mfa_required`) NÃO consulta a política — quem TEM fator prova na sessão, sempre
  - Ligar/desligar em **Configurações › Segurança**; desligar exige sessão `aal2` (senão sessão roubada desliga a proteção com 1 clique)
- Permissão por pipeline (`user_pipeline_access`) **NÃO** entra no MVP

### Audit log
- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget, p99 ≤500ms)
- **Rodada de cron que não fez nada NÃO é mutação e não audita** — a que fez, audita. Vigiado por `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
- Append-only por schema, não por prosa — nenhum papel (nem `service_role`) tem GRANT de UPDATE/DELETE em `api_audit_log`. **Mas tem `TRUNCATE` concedido** a `anon`/`authenticated`/`service_role` (resíduo do dump) — não alcançável pela REST, mas real. Ver ressalva completa e comando de conferência em [`docs/doctrine/audit-log.md`](docs/doctrine/audit-log.md)
- Retenção: 5 anos default, configurável (`AUDIT_LOG_RETENTION_DAYS`), expurgo real via `fn_expurgar_auditoria_vencida` (piso de 90 dias no corpo, cron diário). Sem camada cold/S3 — não existe. Racional completo em [`docs/doctrine/audit-log.md`](docs/doctrine/audit-log.md)
- Falha de write em audit gera alerta Sentry, não bloqueia mutação principal

### LGPD
- Anonimização preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: data_request entregue D+7; redact executado D+15
- Action audit obrigatória: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### WAHA
- Plus obrigatório (Core não suporta multi-tenant, sem retry, sem S3)
- Engine NOWEB default; WEBJS apenas se precisar stickers animados / botões
- Auth: env do WAHA recebe **hash SHA512 hex** da api key; cliente envia plaintext em `X-Api-Key`
- Webhooks: HMAC SHA512 com `crypto.timingSafeEqual`
- Anti-banimento: throttle 1 msg/1.2s + jitter ≤800ms. Campanha 1 msg/5s. Warm-up 7-14d. Spinning de copy. Janela 7h-22h (domingo LIBERADO por default desde 2026-08-20; a janela é knob por canal)
- STOP detection: regra em `lib/opt-out/deteccao.ts`, mesma na ingestão e no runtime do agente.
  Não é palavra solta — só bloqueia palavra ISOLADA ou verbo de cessação + objeto de comunicação
  ("parar de me mandar"). Cobre pt e es, nos dois níveis (inequívoco/ambíguo). Histórico e prova em
  [`docs/business-rules/opt-out-stop.md`](docs/business-rules/opt-out-stop.md)
- Mídia: subir pro Supabase Storage primeiro, passar URL ao WAHA (não inline base64)
- Multi-device: assinar `message.any` (não só `message`); tratar `fromMe=true` sem duplicar
- Grupos: SKIP CRM binding se `chatId.endsWith('@g.us')`. Sender é `p.author`, não `p.from`
- Cron `recover-stuck-messages`: marca `status='sending'` há >5min como `failed` + abre aviso na Central. NÃO toca em `queued` (tem dono, o agent-engine reagenda) e nunca reenvia (dobro é pior que não-envio)

### Marca própria (white-label)
- **Uma imagem Docker serve todas as marcas** — nada de `NEXT_PUBLIC_*`/favicon fixo/imagem por revendedor
- **Banco ACIMA do `.env`**: `platform_branding` + `organizations.settings.branding` são a fonte; `APP_NAME`/`APP_LOGO_URL`/`APP_ACCENT_HEX` são só semente/piso de rollback
- **Resolvedor NUNCA lança** — `lib/branding/{instalacao,saida}.ts` degradam pro padrão do produto (throw ali é 500 em toda tela)
- **Saída sem DOM usa `marcaDaSaida()`** (e-mail, ícone, issuer MFA) — tema claro sempre, nunca `MarcaResolvida` em template de e-mail
- **PDF de LGPD NUNCA leva marca** — nomeia o controlador (`organizations.legal_name`), não o revendedor. Vigiado em `tests/unit/mapas-de-arquitetura.test.ts`
- Vazamento de marca vigiado por `tests/unit/branding.test.ts`. Venda: [`docs/white-label.md`](docs/white-label.md)

### Doutrina DIRC (antes de adicionar campo)
- **D**uplicar — vive aqui mesmo?
- **I**ntegrar — vem de outra tabela via FK?
- **R**eferenciar — só ponteiro?
- **C**alcular — pode ser computado on-demand?

### Modelagem
- 5 tabelas core CRM: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities` (polimórfica timeline), `crm_lead_links` (polimórficos vínculos)
- `position_in_stage numeric` (fractional indexing via `midpoint()`) — **NUNCA `int`**
- `external_id` nullable (mensagem outbound `sending` ainda não tem ID WAHA)
- `type` é `text` + `check constraint`, **não enum** (enum é difícil de estender)
  - **Exceção deliberada — colunas de vocabulário ABERTO:** onde um clone pode ter linhas com valor
    legado (ex.: `crm_lead_activities.type`), o CHECK **não** entra: a constraint faria o `update.sh`
    do clone quebrar, e a doutrina de migrations proíbe. Nesses casos o vocabulário vive só no
    TypeScript, o emissor usa **constante compartilhada, nunca string literal**, e a coluna fica
    **fora** do invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre
    apenas colunas que JÁ têm CHECK. Ver o cabeçalho desse arquivo antes de "completar" o schema.
- `tags text[]` + GIN index; promove pra coluna gerada apenas quando vira hot path
- `custom_fields jsonb` com schema declarativo em `pipeline.settings.fields`; Zod construído dinamicamente
- `vocabulary jsonb` em pipeline permite renomear lead/deal/won/lost (e-commerce: lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado)

---

## Anti-patterns proibidos

1. String que deveria ser FK (ex: `owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth declarado
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. `jsonb` lock-in (UI lê path direto sem schema central)
7. Cascade fantasma (deletar contact cascade em messages perde histórico)
8. Polimórfico sem padronização (`target_kind` cada lugar grava diferente)
9. **Trigger Postgres faz HTTP** (letal — espera rede dentro da transação)
10. Service role usado em request handler sem filtrar `organization_id` manualmente
11. `getSession()` no backend
12. API key em query string
13. Bearer plaintext armazenado no DB (deve ser hash SHA256)
14. `console.log` deixado em código merged (use logger estruturado ou Sentry breadcrumb)

---

## Paths importantes

| Path | Conteúdo |
|---|---|
| `docs/prd/00-prd-master.md` | Visão geral, escopo MVP, KPIs |
| `docs/prd/01-prd-platform-base.md` | Auth, tenancy, RBAC, LGPD framework |
| `docs/prd/02-...06-` | Customer 360, WhatsApp, Pipeline, IA-RAG, Nuvemshop |
| `docs/specs/` | Specs técnicas detalhadas (schema SQL, payloads exatos) |
| `docs/business-rules/` | Regras de negócio fora do código |
| `docs/research/reference-synthesis.md` | Arquitetura herdada do curso WAHA |
| `tasks/todo.md` | Workflow de construção atual |
| `lib/api/wrappers.ts` | `ok()`, `fail()`, tipos `ApiSuccess<T>` / `ApiError` |
| `lib/api/errors.ts` | Códigos de erro canônicos |
| `lib/env.ts` | Validação Zod das env vars (lança no startup se faltar crítica) |
| `lib/supabase/{browser,server,admin}.ts` | Clients canônicos |
| `app/api/v1/health/route.ts` | Health check (Supabase + Redis + WAHA) |
| `supabase/migrations/` | Schema versionado |
| `docs/runbooks/deploy.md` | **Deploy em produção — leia ANTES de mexer na VPS** |

---

## Deploy em produção (NÃO NEGOCIÁVEL)

**Numa VPS que já tem proxy reverso próprio (Hostinger, Coolify, Dokploy…), todo
`up -d` leva os DOIS arquivos de compose:**

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Omitir `-f docker-compose.traefik.yml` recria o contêiner sem as labels de
roteamento; o Traefik da hospedagem deixa de enxergá-lo e **o domínio inteiro
responde `404 page not found`** — com o contêiner `healthy`, porque o
healthcheck é um probe TCP interno e não sabe nada de roteamento.

Depois de qualquer deploy, confirme que o domínio responde **307** (redireciona
pro login) e não 404. Verificações e o caso de build local em
`docs/runbooks/deploy.md`.

O caminho normal **não constrói nada na VPS**: commit → push → PR → merge na
`main` → o CI publica no GHCR → a VPS puxa. Imagem construída na VPS é exceção
de emergência e é dívida: existe só naquele disco e qualquer `up -d` sem
`APP_PULL_POLICY=never` a substitui em silêncio. Vale pros três serviços
(`app`, `worker`, `scheduler`) — um teste reprova regressão. Ver a doutrina abaixo.

---

## Packaging e distribuição — DOUTRINA (NÃO NEGOCIÁVEL)

Lei completa em [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md);
decisões estruturais e o que foi recusado em
[`docs/adr/0001-packaging-e-distribuicao.md`](docs/adr/0001-packaging-e-distribuicao.md).
O não-negociável, em quatro linhas:

1. **Nenhum serviço de `docker-compose.prod.yml` constrói na máquina do
   cliente.** Todo serviço declara `image:` de uma imagem publicada; `build:`
   só existe **ao lado**, como escape. Serviço `build:`-only é invisível para
   `docker compose pull` e imune a `up -d` sem `--build` — ele não é só caro de
   instalar, ele **nunca é atualizado**.
2. **Publicação é ato do CI.** Nunca da sua máquina: build ARM local não roda
   na VPS amd64 do cliente, e a falha só aparece no `up -d` dele. O job
   `imagens-ok` reprova quando qualquer uma das três imagens não constrói —
   status check obrigatório. Confira na fonte antes de confiar nesta linha (comando
   na seção Testes).
3. **Instalação de cliente aponta para número de versão, nunca para tag móvel.**
   `latest` aqui significa **topo da `main`**, não última release — quem quer a
   última release usa `stable`. `pull_policy` acompanha a mutabilidade da tag:
   imutável → `missing`, móvel → `always`.
4. **Dependência upstream é referenciada com tag fixa, nunca republicada.**
   Vale para WAHA (licenciado — republicar é passivo jurídico), Redis, Caddy e
   `serverless-redis-http`.

Bump de versão **não pode** exigir que o operador da VPS edite `.env`, compose
ou qualquer arquivo à mão. Se exigir, não entra: vira issue com plano de
migração e vai para uma major.
---

## Como rodar local

```bash
nvm use                    # node 22
npm install
cp .env.example .env.local  # preencher
docker compose up -d        # WAHA local
npm run dev                 # http://localhost:3000
```

Ver `README.md` pra detalhes de setup.

---

## Testes

```bash
pnpm typecheck   # tsc --noEmit (estrito)
pnpm lint        # eslint next/core-web-vitals
pnpm test:unit   # Vitest (NÃO inclui tests/invariants/** — ver abaixo)
pnpm test:db     # Postgres efêmero + baseline install/update + 364 invariantes
pnpm test:e2e    # Playwright (requer dev server)
```

**⚠️ `test:unit` NÃO é `tests/unit/`.** O script `vitest run` (sem caminho) alcança o repositório
inteiro, não só `tests/unit/` — quem roda `vitest run tests/unit` obtém um verde menor sem perceber.
O comando que vale é `pnpm test:unit`, sem caminho. Ao investigar falha, redirecione e compare
rodapé (`Test Files`/`Tests`, a autoridade) contra `grep FAIL` (pode vir vazio COM falha em execução
sem TTY) — histórico completo, comandos exatos e a armadilha do "vermelho que não é seu"
(`rate-limit.test.ts` sem Redis local) em [`docs/testing/gotchas-ci.md`](docs/testing/gotchas-ci.md).

**Os invariantes não estão no `test:unit`.** `vitest.config.ts` exclui `tests/invariants/**` de
propósito — precisa de Postgres real, roda via `pnpm test:db`/`scripts/test-db.sh`. `test:unit` verde
não prova isolamento RLS.

Checks **obrigatórios** na branch protection da `main` — **reconfira na fonte, não confie nesta
lista** (histórico de já ter divergido em [`docs/testing/gotchas-ci.md`](docs/testing/gotchas-ci.md)):

```console
$ gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
verify, build-and-size, invariants, e2e, imagens-ok
```

`verify` = typecheck+lint+test:unit · `invariants` = `pnpm test:db` (baseline install+update + RLS)
· `build-and-size` = `pnpm build` · `e2e` = quase todas specs Playwright (exceto
`vps-fresh-onboarding`, que é P0 de QA Visual e não entra no CI) · `imagens-ok` = as 3 imagens Docker
constroem. Detalhe de cada um, incluindo como contar specs de verdade (não confiar em grep simples),
em [`docs/testing/gotchas-ci.md`](docs/testing/gotchas-ci.md).

Ao mexer em schema, RLS, RBAC, atribuição, escopo, roteamento, follow-up, webhooks ou automações: rode `pnpm test:db` **localmente** antes de abrir PR. É o único caminho que exercita o `baseline.sql` que o self-hoster realmente aplica.

---

## QA Visual com Recursos Reais — DOUTRINA (produto self-host)

**O DeskcommCRM é distribuído open-source: a experiência de quem instala numa VPS É o produto.** Toda feature nova (ou fix de comportamento visível) DEVE ser provada como um **usuário leigo a usaria de verdade** — pelo frontend, num ambiente que imita a instalação fresca — antes de "pronto". Não é opcional; é critério de aceite de toda sessão que toca UI ou fluxo de usuário.

**Prioridade: primeira impressão acima de tudo.** Onboarding e as primeiras ações (criar conta, conectar canal, primeiro lead, primeiro convite) são a primeira impressão do usuário — bug ali é abandono.

**"Recurso real" = prova pela tela (Playwright, conta real, curl só como diagnóstico) + banco fresco
do `baseline.sql` + dependências locais reais (WAHA/Redis) + envs opcionais AUSENTES + receiver
HTTP real pra efeito colateral externo.** Registro obrigatório em
[`docs/testing/user-journey-map.md`](docs/testing/user-journey-map.md) (mapa de jornadas, receita de
ambiente fresco completa, e o que exatamente conta como "recurso real") + specs em
`tests/e2e/*.spec.ts` + evidência em `.superpowers/evidence/`. Bug achado executando → conserta na
causa raiz, commit próprio, re-teste verde como prova. Medidas de front-end sempre por ferramenta
(`getBoundingClientRect`/`getComputedStyle`), nunca a olho.

---

## Higiene de branches — DOUTRINA (NÃO NEGOCIÁVEL)

**`main` é produção, fonte da verdade. Toda branch começa e se mantém atualizada com ela** — branch atrasada = causa nº1 de conflito em ambiente multi-sessão.

1. **Antes de codar numa branch, atualize:** `git fetch origin && git merge origin/main` (ou `--ff-only` se sem commits próprios).
2. **Nunca `reset --hard`/force pra "atualizar"** — só fast-forward ou merge da `main` pra dentro. `main` nunca é reescrita.
3. **Nunca toque em branch/worktree suja que não é sua** — cheque `git status`/`git worktree list`; se suja e de outra sessão, deixe quieto e avise.
4. **Feature na `main` atrasa todas as outras na hora** — quem retomar aplica a regra 1 primeiro.
5. **Conflito = pare e resolva com cabeça (ou escale)** — nunca escolha lado automático numa branch que não é sua.

---

## Migrations & Banco — DOUTRINA (projeto open-source)

**Este projeto é open-source. Toda mudança de schema DEVE sair como migration versionada** — clone antigo precisa conseguir atualizar aplicando em ordem. **Nunca** `ALTER`/`CREATE` solto sem o arquivo correspondente. Critério de aceite de TODA sessão.

Processo padrão (siga sempre):

1. **Arquivo versionado** em `supabase/migrations/`: `<timestamp>_<NNNN>_<slug>.sql`. `NNNN` é o próximo sequencial (veja `ls supabase/migrations/`).
2. **Idempotente sempre que possível**: `if not exists`, `create or replace function` — pode ser re-aplicada sem quebrar/duplicar.
3. **Portável em `psql` puro**: sem temp table fora de transação explícita, sem `BEGIN`/`COMMIT` (o runner já envolve). Prefira CTE/window/coluna-mapa a temp table.
4. **Data migration genérica**: pense em QUALQUER banco de clone, nunca hardcode ID do seu tenant. Repointe FK pelo catálogo (`information_schema`) pra não perder histórico.
5. **Registre no MANIFEST**: linha em `supabase/migrations/MANIFEST.md` (versão, nome, QUÊ/PORQUÊ).
6. **Reflita no `supabase/baseline.sql` (OBRIGATÓRIO — é o que o kit self-host aplica)**: apêndice idempotente no fim do arquivo, auto-curativo (`if not exists`, dedup ANTES de constraint nova). Sem isso, clones não recebem a mudança ou quebram no `update.sh`. Migração só em `migrations/` sem entrar no baseline **não chega aos self-hosters**.
7. **Aplique e prove**: via `mcp__plugin_supabase_supabase__apply_migration`, capture ANTES/DEPOIS, prove invariantes. Contrato mudou → regenere `lib/database.types.ts`. Schema no kit → valide baseline num Postgres descartável (`install` fresh + `update` re-aplicar, ambos passam).
8. **Backfill de dados quebrados**: dedup/corrija ANTES de criar constraint nova (senão falha nos dados existentes).
9. **Função nova em `public` nasce EXPOSTA — revogue as DUAS origens.** Toda `create function` no schema `public` termina com:

   ```sql
   revoke execute on function public.fn_x(...) from public, anon;
   grant  execute on function public.fn_x(...) to <só quem precisa>;
   ```

   São duas origens distintas de `EXECUTE`, e tratar só uma deixa a função exposta com o gate
   verde: **(A)** o grant direto a `anon` do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS
   TO anon` do baseline (vale pra todo apêndice novo; `revoke from public` **não** remove); **(B)**
   o grant a `PUBLIC` que o Postgres dá a qualquer função ao criá-la (`revoke from anon` **não**
   remove). Sem os dois, o PostgREST expõe a função como RPC alcançável pela anon key. Vigiado por
   `tests/invariants/hardening-definer-varredura.test.ts` (issue #128 achou 8 de 25 expostas
   checando lista fixa de 6).

**Resumo do fluxo de uma mudança de schema:** arquivo em `migrations/` (fonte da verdade p/ Supabase CLI) **+** apêndice idempotente no `baseline.sql` (p/ o kit self-host) **+** linha no MANIFEST. Os dois artefatos de schema andam juntos. Nunca edite migrations já aplicadas — corrija com uma "forward-fix" nova (e mais um apêndice no baseline).

---

## Skills relevantes a usar (Claude Code)

- `superpowers:brainstorming` — antes de implementar feature não-trivial
- `superpowers:writing-plans` — pra task com mais de 1 etapa de DB/API
- `superpowers:test-driven-development` — feature crítica (LGPD, RLS, anti-banimento)
- `superpowers:systematic-debugging` — bugs reportados
- `superpowers:verification-before-completion` — antes de declarar "pronto"
- `tomik-db-doctrine` — referência cruzada de doutrina de schema
- `supabase:supabase` — qualquer task com Supabase
- `vercel:nextjs` — App Router, Server Components, edge runtime
- `vercel:ai-gateway` — config de fallback de provider
- `frontend-design` — UI distinta (não cair em shadcn-default genérico)

---

## Definition of Done

Antes de declarar uma task pronta:

1. `npm run typecheck` passa zerado
2. `npm run lint` zerado
3. Testes unit/e2e relevantes existem e passam
4. RLS testada se feature toca tabela tenant-aware
5. Audit log emitido se há mutação relevante
6. Rate limit aplicado se rota é pública
7. Zod valida todo input externo
8. Sem `console.log` esquecido
9. Env vars novas adicionadas em `.env.example` + `lib/env.ts`
10. Doc atualizada se mudou contrato (PRD/spec)
11. **Mudança de schema saiu como migration versionada + linha no MANIFEST** (ver Doutrina de Migrations) — clones conseguem atualizar
12. **Se tocou UI/fluxo de usuário: provado pela tela como um leigo faria**, em ambiente fresco estilo VPS, com evidência visual (ver Doutrina de QA Visual com Recursos Reais) — curl não conta
13. **Living System Checklist respondido** (lei em `docs/doctrine/sistema-vivo.md`; racional no manual `docs/doctrine/sistema-vivo/`) — a feature não é ilha: tem entrada + saída, emite atividade/log, aparece na tela, tem porta na navegação, tem mecanismo anti-morte, **declara seu laço de retorno** (invariante 7 — o que muda no sistema quando ela erra), e o mapa vivo (`docs/architecture/`) reflete peça nova com ≥2 arestas. Resposta que não **nomeia o artefato concreto** (consumidor real, tela real, log real) não conta
14. **Tela nova tem porta** — declarada em `lib/navigation/registry.ts` com seu grupo, ou na allowlist de `tests/unit/navegacao-completude.test.ts` **com justificativa escrita**. Ter tela e ser alcançável são coisas diferentes: o CI reprova tela que existe mas em que só se chega digitando a URL
15. **Se tocou Dockerfile, compose ou setup kit: a mudança chega a quem já instalou** (lei em `docs/doctrine/packaging.md`) — nenhum serviço de produção ficou `build:`-only; variável nova tem default que não quebra `.env` antigo; a atualização não pede edição manual de arquivo; e, se mudou o que a imagem contém, o `update.sh` alcança essa peça. Rode `pnpm test:shell` — é o único gate que exercita o kit
16. **Se o PR muda comportamento, corrija a afirmação de estado sobre esse comportamento** — só
    sobre o que você mudou, só nos documentos de autoridade. Onde a afirmação puder virar
    **comando** (`rode isto para saber`), troque em vez de corrigir número — número envelhece de
    novo. Contexto: [`docs/audits/2026-08-14-afirmacoes-de-estado.md`](docs/audits/2026-08-14-afirmacoes-de-estado.md).
17. **Se o PR muda comportamento visível a quem opera uma VPS, traz fragmento em `.changes/`**
    (`nada_mudou`/`capacidade_nova`/`exige_acao`, nunca o número — lei em
    [`docs/doctrine/versionamento.md`](docs/doctrine/versionamento.md)). Confira com
    `pnpm release:conferir`. CI valida a forma, não cobra presença — isso é cobrado por quem revisa.

Um staff engineer aprovaria? Se não, itera.

---

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
