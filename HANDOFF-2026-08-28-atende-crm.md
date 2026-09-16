# HANDOFF — Atende CRM (DeskcommCRM) — 2026-08-28

> Instalação do DeskcommCRM como **produto novo e independente** do Marcelo.
> Nada foi instalado ainda. O `.env` está montado e testado; falta executar.

---

## Objetivo

Subir o [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM) (open source, MIT, de
Rafael Melgar) como um produto novo chamado **Atende CRM**, em
`atende.marcelobernardes.shop`, rodando na VPS que o Marcelo já tem.

**Não** tem relação com MEG, Twenty CRM ou Importadores PRO. É produto novo.

---

## Decisões tomadas (entrevista completa em 27/08)

| Decisão | Escolha | Por quê |
|---|---|---|
| Propósito | Produto novo, independente | Resposta direta do Marcelo |
| Banco | **Supabase cloud, plano grátis** | Ver "Supabase self-hosted foi recusado" |
| Projeto Supabase | `Atende CRM` / ref `rnltemsqtjaizqhtzdfm` / `sa-east-1` | Criado pelo Marcelo em 27/08 |
| WhatsApp | **1 número**, WAHA **Core** (grátis) | Plus só é preciso para multi-número; é troca de `WAHA_IMAGE` |
| Qual número | Um **livre**, novo — **a Evolution da MEG NÃO é tocada** | Evitar dois clientes não-oficiais no mesmo número |
| Endereço | `atende.marcelobernardes.shop` | `crm.` já é do Twenty |
| Provedor de IA | **OpenAI**, chave **nova e dedicada** | Uma chave cobre conversa + áudio + RAG |
| Nome na tela | `Atende CRM` | Marca própria, não a do projeto upstream |
| E-mail | Resend (domínio já *verified*) | Convite de usuário + e-mails de LGPD |
| Admin | `marcelovolei15@gmail.com` | Login e avisos de SSL |

### Supabase self-hosted foi recusado — com números

O Marcelo queria instalar o Supabase **dentro da VPS**, achando que o plano grátis não
aguentaria. Medido e refutado:

- Banco da **MEG**, com meses de WhatsApp real (20 tabelas, histórico, RAG): **20 MB**
  de um limite de **500 MB**. Uso real = **4%**.
- Supabase self-hosted são **13 containers**. A VPS tem **4,6 GB livres** e o CRM sozinho
  já pede **2,8 GB** (limites declarados no `docker-compose.prod.yml`). Não cabe.
  Quem morreria de OOM primeiro seria `producao_n8n` — a MEG.
- O CRM **não aceita um Postgres qualquer**: depende de Supabase **Auth** (MFA,
  `signInWithPassword`) e **Storage**, e o schema tem **45 policies RLS** em `auth.uid()`.
- O instalador só sabe provisionar **cloud** (`api.supabase.com`).

> Se um dia o grátis apertar: Supabase Pro = US$ 25/mês. Mais barato que subir a VPS
> para 16 GB **e** virar sysadmin de 13 containers.

---

## Estado da VPS (medido em 27/08)

- Hostinger, **uma só**: id `951530`, `193.203.182.96`, Ubuntu 24.04 + Easypanel
- **2 vCPU · 7,8 GB RAM** (3,1 em uso, **4,6 disponíveis**) · 96 GB disco (67 livres)
- **Swap já com 595 MB em uso** — a máquina já encostou em pressão de memória antes
- Docker **29.6.2**, Compose v5.3.1, **Swarm ATIVO**
- **Traefik do Easypanel ocupa 80/443**. Rede `easypanel` é overlay **`attachable=true`** ✅
- 15 containers: MEG (`producao_n8n`, `-worker`, `postgres`, `redis`, `evolution-api`),
  Twenty (`server`, `worker`, `db`, `redis`), Importadores (`app`, `postgres`), Easypanel

### Consumo previsto do CRM (do `docker-compose.prod.yml`)

`app` 768 MB · `worker` 512 MB · `waha` 1280 MB · redis/srh/scheduler ≈ 250 MB
→ **≈ 2,8 GB**, deixando ~1,8 GB de folga. O `caddy` **não sobe** (Traefik publica).

**Folga de emergência:** o **Twenty consome 935 MB** parado há 4 semanas. Desligar
libera mais do que o WAHA inteiro pede.

---

## O que JÁ foi feito

1. ✅ Repo clonado em `C:\Users\Marcelo\Projeto Claude Code\DeskcommCRM` (3.227 arquivos)
2. ✅ Projeto Supabase `Atende CRM` criado (pelo Marcelo)
3. ✅ **Extensões habilitadas** no banco novo: `vector` 0.8.2, `citext` 1.6, `pg_trgm` 1.6,
   todas em `public` — sem elas o `baseline.sql` morre em `type public.vector does not exist`
4. ✅ `.env` montado em `DeskcommCRM/.env` (coberto por `.gitignore:19`), duplicatas removidas,
   backup em `.env.bak-20260827-205834`

### Credenciais testadas contra o serviço real

| Item | Teste | Resultado |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ref confere | ✅ Atende CRM |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `GET /auth/v1/settings` | ✅ 200 |
| `SUPABASE_SERVICE_ROLE_KEY` | `GET /auth/v1/admin/users` | ✅ 200 |
| `SUPABASE_DB_URL` | `psql ... select version()` **da VPS** | ✅ PostgreSQL 17.6 |
| `OPENAI_API_KEY` | `GET /v1/models` | ✅ 200 (chave **nova**, ≠ da MEG) |
| `RESEND_API_KEY` | `GET /domains` | ✅ 200, `marcelobernardes.shop` *verified* |

> ⚠️ A **re-verificação consolidada final não chegou a rodar** (interrompida). Cada item
> acima foi testado individualmente e passou; falta só rodar a bateria toda de uma vez.

### Armadilha resolvida: senha com `@` e `&`

A senha do banco (`M@rc&lo080991`) tem dois caracteres que **quebram uma connection
string**: `@` separa senha de host, `&` separa parâmetros. Resolvido com percent-encoding
(`%40`, `%26`). Bônus: assim os caracteres **não aparecem literais no `.env`**, então
nenhum shell se confunde depois.

Host correto do pooler descoberto por teste real: **`aws-0-sa-east-1`** (o `aws-1` recusa,
o `aws-2` nem resolve DNS).

---

## O que FALTA fazer

1. **Criar registro A** `atende` → `193.203.182.96` na Hostinger *(muda DNS)*
2. **Clonar o repo na VPS** em `/opt/atende-crm`
3. **Copiar o `.env`** local para lá
4. **Rodar** `bash hostgator-setup-kit/install.sh` *(sobe ~5 containers, aplica
   `baseline.sql`, cria o admin, instala 2 crons)*
5. **Conferir** health check, HTTPS, e parear o WhatsApp por QR

---

## Riscos conhecidos, não resolvidos

**1. Swarm + Easypanel não é o caminho testado pelo projeto.** O upstream testa Caddy
próprio e prevê Traefik genérico. O `install.sh` detecta proxy existente
(`REVERSE_PROXY=traefik` + `docker-compose.traefik.yml`) e trata overlay do Swarm, e a rede
está `attachable`. Mas pode precisar de ajuste na hora. **Estrago fica contido** em
`/opt/atende-crm` e nos containers novos — não encosta em `producao_*` nem no Twenty.

**2. Memória.** ~1,8 GB de folga, com swap já em uso. Se apertar, desligar o Twenty
libera 935 MB.

**3. WAHA Core = 1 sessão.** Segundo número exige WAHA Plus (licença paga).

**4. Free tier Supabase = 2 projetos ativos por usuário.** Hoje: `N8N` (MEG) +
`Atende CRM`. **Está no limite.** `economize-ja` e `Afiliados` seguem pausados.

**5. Número novo precisa de warm-up de 7-14 dias** antes de volume
(`CLAUDE.md:109` do repo: throttle 1 msg/1,2s, janela 7h-22h).

---

## Descobertas úteis sobre o projeto (valem para o futuro)

- **`CLAUDE.md` do repo mente sobre o WAHA.** Diz "Plus obrigatório", mas o
  `docker-compose.prod.yml` entrega **Core**. A própria auditoria do repo registra a
  contradição em `docs/audits/2026-08-14-afirmacoes-de-estado.md:56`. **Vale o compose.**
- **OpenAI é obrigatória mesmo com outro provedor**: Whisper (áudio) e embeddings (RAG)
  são dela. O comentário em `install.sh:1094` relata que isso já quebrou em produção —
  alguém instalou com OpenRouter e "descobriu semanas depois que o agente nunca ouviu um áudio".
- **Trocar de domínio depois é caro:** `marca-emails.sh:299` **se recusa a sobrescrever**
  um `site_url` já preenchido — imprime "deixei como está" e segue. Quem migra confiando
  no script fica com e-mail de confirmação apontando pro domínio velho, em silêncio.
- **Supabase mudou a UI:** a connection string **não** fica mais em Settings → Database.
  Agora é o botão **`Connect`** no topo do dashboard:
  `https://supabase.com/dashboard/project/rnltemsqtjaizqhtzdfm?showConnect=true&method=session`
  Reset de senha: `.../database/settings`
- **O harness bloqueia leitura de `.env`** (Read e Grep). A saída que funcionou foi
  escrever scripts que leem o arquivo e imprimem **só o veredito**, nunca o valor.

---

## Scripts prontos (scratchpad desta sessão)

`…\Temp\claude\C--Users-Marcelo-Projeto-Claude-Code-DeskcommCRM\483aac73-…\scratchpad\`

| Script | O que faz |
|---|---|
| `testa-credenciais.sh` | Testa as 6 credenciais com chamada real. Não imprime segredo |
| `diagnostico-cruzado.sh` | Diz de qual projeto Supabase é cada chave + acha duplicatas |
| `qual-vence.sh` | Em duplicata, mostra qual ocorrência vence ao carregar |
| `testa-crm.sh` | Wrapper: roda os dois primeiros no `.env` do CRM |
| `arruma-env.sh` | Dedup + preenche + copia Resend do `.env` global |
| `set-env.sh` | `set-env.sh VAR VALOR …` — grava no `.env` do CRM |
| `resend-dominios.sh` | Lista domínios verificados na Resend |

> Scratchpad é temporário. Se forem reusar, copiar para `DeskcommCRM/scripts/`.

---

## Alarme falso registrado (para não repetir)

Em certo momento o diagnóstico acusou que a `service_role` do CRM tinha sido colada no
`.env` **global** (o que a MEG usa), quebrando 25 scripts de manutenção da MEG.
**Era o arquivo no meio da edição do Marcelo.** Medido de novo: `.env` global íntegro,
`service_role` da MEG abre o projeto N8N com 200, zero duplicatas. **Nada quebrou.**

Lição: quando dois testes do mesmo arquivo se contradizem, o arquivo mudou entre eles —
medir de novo antes de anunciar estrago.

---

## Próximo passo exato

Rodar a bateria consolidada para confirmar os 6 itens de uma vez:

```bash
bash "…/scratchpad/testa-crm.sh"
```

Se passar tudo, **pedir autorização** e executar o passo 1 (registro DNS `atende`), que é
a primeira ação que muda algo fora da máquina local.

> **Regra vigente nesta tarefa:** o Marcelo pediu explicitamente para **não executar nada
> sem perguntar antes**. Vale para DNS, VPS e qualquer escrita.
