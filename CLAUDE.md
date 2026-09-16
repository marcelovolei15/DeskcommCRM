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

- **Frontend:** Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito + Tailwind 4 (config em CSS — ver abaixo) + shadcn/ui (style: `new-york`, neutral)
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
- **Rodada de cron que não fez nada NÃO é mutação e não audita** — e a que fez, audita. `routing-worker` (1×/min) e `attendant-heartbeat` (1×/5min) auditavam incondicionalmente: ~51.840 linhas/mês numa instalação que não atende ninguém, e numa VPS real **95% do audit log** era batida de cron vazia (`docs/testing/user-journey-map.md`, achado 17). A guarda certa é *auditar quando houve efeito*, nunca *parar de auditar* — as duas direções são medidas por `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`, que varre o AST de **toda** rota de `app/api/v1/cron/`
- Audit é append-only para os papéis do PostgREST, e isso é do SCHEMA e não da prosa: `anon`, `authenticated` e `service_role` não têm GRANT de UPDATE, DELETE **nem TRUNCATE** em `api_audit_log` — **nem `service_role`** (migration 0258). O dono (`postgres`) pode tudo, como em qualquer tabela: a garantia é sobre os papéis que o PostgREST assume, nunca absoluta. Para conferir na fonte em vez de acreditar nesta linha:

  ```bash
  psql "$SUPABASE_DB_URL" -c "select grantee, privilege_type from information_schema.role_table_grants
    where table_schema='public' and table_name='api_audit_log'
      and privilege_type in ('DELETE','UPDATE','TRUNCATE')
      and grantee in ('anon','authenticated','service_role','PUBLIC');"
  ```

  O resultado esperado é **vazio**. Sem o filtro de `grantee` aparecem as linhas
  do dono `postgres` — e elas não são defeito. Racional completo em [`docs/doctrine/audit-log.md`](docs/doctrine/audit-log.md).

  **Até a 0258 a primeira frase deste item era falsa no Supabase real, com o
  gate verde.** Todo projeto Supabase nasce com um default ACL de TABELAS em
  `public` que concede tudo aos três papéis — confira com
  `select defaclacl from pg_default_acl where defaclobjtype = 'r' and defaclnamespace = 'public'::regnamespace;`
  —, e o `GRANT` enumerado que o dump emite para esta tabela só ACRESCENTA, não
  retira. Com a service key, que ignora RLS, uma linha escolhida da auditoria
  era apagada ou reescrita pela REST; `anon`/`authenticated` só não o faziam
  porque a RLS não tem policy de UPDATE/DELETE.

  **A lição que sobrevive ao conserto é sobre a régua, não sobre o grant.** A
  sonda de `tests/invariants/retencao-poda-e-expurgo.test.ts` ficou verde duas
  vezes medindo o universo errado: primeiro perguntando só por DELETE/UPDATE com
  TRUNCATE concedido ao lado; depois perguntando pelos três num Postgres onde o
  prelude de `scripts/test-db.sh` reproduz o default ACL do Supabase para
  FUNÇÕES e não para TABELAS — um banco onde o defeito não pode existir. Quem
  mede o Supabase real é
  `tests/invariants/audit-log-sob-o-default-acl-do-supabase.test.ts`: concede o
  default ACL à tabela, reaplica o bloco da 0258 extraído do baseline e só então
  sonda. **Enumerar privilégios no dump não protege tabela nenhuma no Supabase
  real**; o que protege é `revoke` explícito no apêndice. Quais tabelas o dump
  enumera em vez de `GRANT ALL`:

  ```bash
  grep -nE '^GRANT [A-Z,]+ ON TABLE' supabase/baseline.sql | grep -v 'GRANT ALL'
  ```
- **Retenção default de 5 anos, configurável, e agora EXECUTADA.** O expurgo é `public.fn_expurgar_auditoria_vencida` (`security definer`, **piso de 90 dias dentro do corpo**, revogada de anon/authenticated), chamada em lotes pelo cron `app/api/v1/cron/data-retention` (diário). O knob é `AUDIT_LOG_RETENTION_DAYS`. **Não há camada cold/S3** — o "hot 90 dias, cold (S3) o resto" que este arquivo afirmava por meses nunca existiu em código (auditoria de 2026-08-14: zero ocorrência de arquivamento), e um self-host não tem para onde arquivar: o Storage do cliente é a MESMA cota de 1 GB, já dividida com `whatsapp-media`. Para ver o que está em vigor: `grep -n "RETENCAO_AUDITORIA_DIAS" lib/retencao/politica.ts`
- Por que uma `security definer` de expurgo não é porta de adulteração (o argumento inteiro está no cabeçalho da migration 0167): ela **não tem seletor de linha** — nenhum parâmetro de org, ator, ação ou id, e o único predicado é `created_at < now() - N dias`; o piso mora **no corpo**, não em quem chama; não é alcançável pela REST; é, desde a 0258, o **único** apagamento de auditoria ao alcance da service key — e não escolhe linha, só alcança a ponta mais velha que o piso; e **registra a própria erosão** (`retention.sweep_run`, com a contagem, numa linha nova demais para a chamada seguinte alcançar)
- Falha de write em audit gera alerta Sentry, não bloqueia mutação principal

### LGPD
- Anonimização preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: data_request entregue D+7; redact executado D+15
- Action audit obrigatória: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### WAHA
- Default fixo `devlikeapro/waha:latest-2026.7.2`, NOWEB. A prova local criou duas sessões CORE simultâneas até `SCAN_QR_CODE`; não prova pairing, duas contas `WORKING` nem envio. Não bloquear segunda sessão por tier: conferir resposta estruturada e pós-condição da operação.
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
| `app/globals.css` | **Tailwind 4 é CSS-first: não existe `tailwind.config.ts`.** Tokens em `:root` / `[data-theme]`, ponte token → utilitário no `@theme inline`, alcance do scanner nos `@source`. Vigiado por `tests/unit/tailwind-tokens.test.ts` |
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

Duas armadilhas irmãs, as duas pagas no mesmo dia:

- **Gate escolhido não é suíte.** `typecheck`, `lint`, `lint:channels` e os arquivos de cerca
  podem estar todos verdes enquanto a suíte tem 17 falhas — nenhum deles toca o arquivo que
  quebrou. Antes de abrir PR, rode a suíte, não os gates que você lembra.
- **Não corte a saída.** `| tail -8` guarda o rodapé e joga fora os NOMES dos arquivos que
  falharam, que é o único dado que permite reconciliar depois. Redirecione e filtre:

  ```bash
  pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
  grep -aE "Test Files|Tests " /tmp/vt.log | tail -2                   # ← a AUTORIDADE
  grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c   # arquivos + contagem
  ```

  **O rodapé é a autoridade; o `grep FAIL` é conveniência — e ele pode devolver
  vazio COM falhas.** Medido: em execução sem TTY o reporter padrão às vezes
  imprime só o resumo, e os nomes dos arquivos vermelhos nunca chegam a ser
  escritos. Uma rodada com `3 failed` produziu um log de 629 bytes onde `FAIL`
  não aparece em posição nenhuma — e o vazio dessa sonda lê exatamente como
  "nenhuma falha".

  Por isso **compare as duas saídas antes de concluir** — e compare a linha
  certa: `Test Files N failed` conta ARQUIVOS, `Tests N failed` conta CASOS, e o
  `uniq -c` do `grep` soma CASOS. O controle é contra a segunda linha:

  ```bash
  r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
  g=$(grep -acE "^ *FAIL " /tmp/vt.log)
  echo "rodapé: ${r:-0 failed} | grep contou: $g"   # têm de bater
  ```

  Se não baterem, a sonda está cega — troque por `--reporter=verbose` e rode de
  novo, em vez de acreditar no silêncio.

  **E as duas podem bater em zero com a suíte reprovada.** O Vitest sai com
  `exit=1` quando há **erro não tratado** durante a execução, mesmo com todos os
  testes passando — e esse erro aparece numa TERCEIRA linha do rodapé, que
  nenhuma das duas sondas acima lê:

  ```
   Test Files  866 passed (866)
        Tests  8904 passed | 1 expected fail (8905)
       Errors  1 error          ← só o exit code viu isto
  ```

  Medido em 2026-09-15: `EnvironmentTeardownError: [vitest-worker]: Closing rpc
  while "onUserConsoleLog" was pending`, sob carga. Rodapé `0 failed`, `grep FAIL`
  vazio, exit 1. **O exit code é a autoridade; o rodapé e o grep são explicação
  dele.** Quando o exit diverge dos dois, leia a linha `Errors` antes de concluir
  qualquer coisa:

  ```bash
  grep -aE "^ *Errors " /tmp/vt.log      # vazio é o esperado
  ``` (Comparar contra `Test Files` dá
  divergência falsa: `2 failed` de arquivos contra `7` de casos parece defeito
  da sonda e é só régua trocada.)

**Vermelho local que NÃO é seu:** `lib/ai/dispatcher/rate-limit.test.ts` falha em 5 casos, com
15s de timeout cada, quando o `.env.local` tem `UPSTASH_REDIS_REST_URL`/`TOKEN` e o Redis para o
qual eles apontam **não está de pé** (neste repo é o `serverless-redis-http` local, não a nuvem).
O `tests/setup/vitest.setup.ts` carrega o `.env.local` para dentro do `process.env`, e o módulo
só usa o contador em memória quando essas variáveis estão **ausentes**. Provado nos dois sentidos.
No CI não há `UPSTASH` nenhum, então lá o caminho é o contador em memória e o arquivo passa.

Checks **obrigatórios** na branch protection da `main` (verificado na configuração, não só no papel):

- **`verify`** (`ci.yml`) — typecheck + lint + test:unit.
- **`invariants`** (`ci.yml`) — `pnpm test:db`: sobe `pgvector/pgvector:pg15` — o PISO que dizemos suportar, não a versão mais rica que temos à mão —, aplica `supabase/baseline.sql` em modo install (`ON_ERROR_STOP=1`) e update (idempotência), e roda os testes de invariante, incluindo o de isolamento RLS entre 2 organizações.
- **`build-and-size`** (`perf.yml`) — `pnpm build` em Node 22.
- **`e2e`** (`e2e.yml`) — sobe Supabase local, aplica o `baseline.sql` e roda **todas as specs Playwright menos as que `FORA_DO_CI` declara**. O número saiu daqui de propósito: ele apodreceu **cinco** vezes (a quinta em 2026-08-24, quando `inbox-quem-manda.spec.ts` entrou), e a condição que o PR #242 pôs para parar de recontar já tinha vencido na quarta. Quem precisa do número roda o comando abaixo — comando não envelhece. Quais ficam de fora, e por quê, é o que a própria variável diz — **não confie nesta linha, leia-a**:

  ```bash
  git show origin/main:.github/workflows/e2e.yml | \
    python3 -c "import sys,re; y=sys.stdin.read(); print(sorted({s for _,c in re.findall(r'(FORA_DO_CI):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)}))"
  ```

  Esta frase já dizia "a **única** de fora é `vps-fresh-onboarding`" e estava errada: em 2026-09-04 a variável listava **duas** (`inbox-tempo-real` entrou depois). É o mesmo defeito que o parágrafo acima descreve — afirmação de estado que envelhece —, cometido na frase seguinte à que o denuncia. O que continua verdade e é o que importa: `vps-fresh-onboarding` é a **P0** da doutrina de QA Visual, então `e2e` verde **não** prova a jornada de instalação fresca, que é o produto que se vende.

  **Não confie em `grep` no arquivo inteiro.** `grep -oE '[a-z0-9-]+\.spec\.ts' .github/workflows/e2e.yml | sort -u | wc -l` conta quem é CITADO, não quem é INVOCADO: a `FORA_DO_CI` é uma variável YAML como as outras e entra na conta. (Até 2026-08-14 este parágrafo culpava "menções em comentários", e isso é falso — medido, o conjunto de specs citadas fora de variável é **vazio**.) O que roda são as `SPECS_PARTE_*`:

  ```bash
  ls tests/e2e/*.spec.ts | wc -l                    # quantas existem
  python3 - <<'PY'                                  # quantas o CI invoca
  import re
  y = open(".github/workflows/e2e.yml", encoding="utf-8").read()
  print(len({s for _, c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)', y)
               for s in re.findall(r'[a-z0-9-]+\.spec\.ts', c)}))
  PY
  ```

  **Por que não há mais número aqui.** O conserto que este parágrafo pedia era pôr a prosa sob gate — `tests/unit/e2e-cobertura-completa.test.ts` cobrando também o texto daqui. Tirar o número é melhor e mais barato: não há o que policiar, e a diferença entre disco e CI segue vigiada onde importa, no próprio teste, que reprova toda spec nova que não esteja em `SPECS_PARTE_*` ou em `FORA_DO_CI` **com motivo escrito**. Prosa que nenhum gate lê é prosa que diverge; prosa que não afirma número não tem como divergir.
- **`imagens-ok`** (`publish-image.yml`) — reprova quando qualquer uma das três imagens Docker não constrói. **É obrigatório desde 2026-08-13**; este arquivo dizia o contrário em outro parágrafo (ver a doutrina de packaging acima, já corrigida).

Todos os **cinco** são **obrigatórios** — medido em 2026-08-14 na branch protection:

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

**Registro obrigatório (senão o progresso é invisível):**
- Mapa de jornadas vivo em `docs/testing/user-journey-map.md` — casos por jornada, prioridade (`[P0]` primeira impressão), e achados. Atualize quando adicionar cobertura ou achar bug.
- Specs em `tests/e2e/*.spec.ts` que dirigem o **frontend** (não só API). Evidência visual (screenshot/trace) em `.superpowers/evidence/`.
- Bug achado executando → **conserta na causa raiz**, com migration versionada se tocar schema (ver doutrina abaixo), commit próprio, e re-teste verde como prova.

**Medidas de front-end por ferramenta, nunca a olho** (`getBoundingClientRect`/`getComputedStyle` no Playwright). Ver `feedback_protocolo_execucao_visivel` na memória.

**Receita de ambiente fresco (não-óbvia):** banco = `baseline.sql` num Supabase local **pg15** (`config.toml major_version = 15`). Já foi pg17, por causa de 9 `GRANT MAINTAIN` que o `pg_dump` emitiu sozinho; hoje quem guarda o piso é `tests/unit/baseline-no-piso-do-postgres.test.ts`; `next build` + `next start` (produção — `next dev` compila lento demais e o Turbopack quebra `cookies()`); **worktree com `node_modules` real, nunca symlink** (Turbopack rejeita symlink "out of filesystem root") e **fora de `/tmp`** (é limpo no meio da sessão — commite cada marco). Detalhes em [[project_invite_e2e_and_bugs]].

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

1. **Arquivo versionado** em `supabase/migrations/` com o padrão do repo: `<timestamp>_<NNNN>_<slug>.sql` (ex.: `20260706210000_0027_whatsapp_conversation_unification.sql`). `NNNN` é o próximo número sequencial — e **não** é o do último arquivo da listagem:

   ```bash
   ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
   ```

   O nome do arquivo começa pelo **timestamp**, e timestamp e `NNNN` podem discordar: em
   09/09/2026 o `ls | tail -1` devolvia o `_0230_` (timestamp de 07/09) enquanto o maior `NNNN`
   era `_0231_` (timestamp de 05/09). Um contribuidor externo seguiu a instrução antiga ao pé da
   letra, escolheu `0231`, e o `manifest-x-migrations` reprovou o PR dele por colisão — a
   instrução é que estava errada, não ele. Ordene pelo número, nunca pela listagem.
2. **Idempotente sempre que possível**: `add column if not exists`, `create ... if not exists`, `create or replace function`. Uma migration deve poder ser re-aplicada sem quebrar nem duplicar efeito.
3. **Portável em `psql` puro** (clones podem não usar o MCP/CLI Supabase): **sem** `create temporary table ... on commit drop` fora de transação explícita; **sem** `BEGIN`/`COMMIT` explícito (o runner já envolve em transação, como as demais migrations). Prefira CTEs, subqueries de janela e colunas-mapa (ex.: `is_merged_into`) a temp tables.
4. **Data migrations genéricas**: se a migration corrige/deduplica dados, escreva pensando em QUALQUER banco de clone (não hardcode IDs do seu tenant). Repointe FKs conferindo o catálogo (`information_schema` FK map) para não perder histórico.
5. **Registre no MANIFEST**: adicione uma linha em `supabase/migrations/MANIFEST.md` (tabela "Applied") descrevendo versão, nome e o QUÊ/PORQUÊ.
6. **Reflita no `supabase/baseline.sql` (OBRIGATÓRIO — é o que o kit self-host aplica).** O baseline é um dump `--schema-only` + um **apêndice idempotente** no fim do arquivo (blocos rotulados `-- ---- <coisa> (migration NNNN) ----`). O kit HostGator aplica **só o baseline.sql**, tanto no `install.sh` (banco novo, `ON_ERROR_STOP=1`) quanto no `update.sh` (re-aplica em banco existente, **sem** `ON_ERROR_STOP`). Então toda mudança de schema pós-snapshot DEVE ser acrescentada ao apêndice, **idempotente e auto-curativa**: `add column if not exists`, `create ... if not exists`, `create or replace function`, e — se a mudança adiciona constraint — **deduplicar/corrigir os dados ANTES** de criar a constraint (senão o `update.sh` de um clone bugado quebra). Sem isto, clones não recebem a mudança (ou quebram ao atualizar). Migração adicionada só em `migrations/` mas não no baseline **não chega aos self-hosters**.
7. **Aplique e prove**: aplique via `mcp__plugin_supabase_supabase__apply_migration` (ou `supabase db push`), capture o estado ANTES/DEPOIS e prove invariantes (ex.: contagem de linhas que não pode mudar). Se mexeu em contrato, regenere `lib/database.types.ts`. Para mudanças de schema no kit, valide o baseline num Postgres descartável (`pgvector/pgvector:pg15` + extensões) aplicando `install` (fresh, `ON_ERROR_STOP=1`) e `update` (re-aplicar, sem a flag) — ambos têm que passar.
8. **Backfill de dados quebrados existentes**: constraint nova falha se os dados atuais a violam — a migration (e o apêndice do baseline) deve deduplicar/corrigir ANTES de criar a constraint.
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

**Guias embutidos neste repositório** (`.claude/skills/`, espelho gerado de `.agents/skills/` — a
mesma tabela vale para Codex, Cursor, OpenCode e Antigravity; ver `AGENTS.md`):

- `deskcomm-instalar` — instalar, atualizar ou consertar a instalação numa VPS
- `deskcomm-cliente-novo` — configurar o CRM para um cliente ou nicho (agentes, roteadores, follow-ups, conhecimento)
- `deskcomm-metricas` — desempenho, conversão, custo de IA, funil, relatório
- `deskcomm-prompt` — afinar o prompt de um agente que não performa
- `deskcomm-contribuir` — o espelho da triagem, antes do PR; fica quieto para o mantenedor
- `deskcomm-doutrina` — as três regras que mais custam, antes de escrever código

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
14. **Tela nova tem porta** — declarada em **`lib/navigation/catalogo.ts`** (no `NAV_CATALOG`, com seu grupo), ou na allowlist de `tests/unit/navegacao-completude.test.ts` **com justificativa escrita**. Ter tela e ser alcançável são coisas diferentes: o CI reprova tela que existe mas em que só se chega digitando a URL.

    ⚠️ Esta linha dizia `lib/navigation/registry.ts`, e quem a seguisse abria um
    arquivo **sem um único lugar onde declarar**: o `registry.ts` só deriva
    (`NAV_DESTINATIONS` sai de `NAV_CATALOG`) e reexporta. Ele é a FACE do
    módulo — é dele que o teste importa, e por isso o engano é fácil. Quem
    declara é o catálogo. Para conferir sem acreditar nesta linha:

    ```bash
    grep -c 'href:' lib/navigation/catalogo.ts lib/navigation/registry.ts
    ```
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
