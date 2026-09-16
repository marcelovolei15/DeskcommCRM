# HANDOFF — Cobrança via Asaas (planos UP/PLUS/PREMIUM, Grupo, Comunidade)

> Documento **vivo**. Plano técnico, ainda não implementado. Fork próprio
> (`marcelovolei15/DeskcommCRM`) — não depende de aprovação do upstream
> (`melgarafael/DeskcommCRM`) pra existir; upstream só entra se um dia
> quiser mandar isso de volta como PR.

- **Instância:** Atende CRM, `atende.marcelobernardes.shop`
- **Criado:** 2026-09-10 — planejamento, zero código escrito ainda
- **Contexto:** ver `[[project_atende_crm]]` na memória do Claude

---

## O pedido, em uma frase

DeskcommCRM não tem gateway de pagamento nenhum. A MEG (Nutricionista, n8n)
resolve isso com uma tool que fala direto com a API do Asaas. Precisamos do
mesmo aqui: o agente gera link de cobrança, e quando o cliente paga, o sistema
sabe.

## Diagnóstico medido (10/09/2026, antes de qualquer mudança)

- `orders` existe, mas é **fechada por CHECK constraint** a
  `nuvemshop`/`vtex`/`shopify` (`orders_external_provider_check`,
  `supabase/baseline.sql:1715`) — é pedido de loja física importado, não
  cobrança gerada pelo agente. Não serve, não dá pra reaproveitar sem migração
  nova que abra o enum.
- `webhook_sources` existe, mas `kind` é fechado a `'lead_capture'`
  (`supabase/baseline.sql`, ver constraint) — é webhook de formulário virando
  lead, formato incompatível com evento de pagamento do Asaas.
- `calendar_event_types` (tipo de consulta) **não tem coluna de preço**.
  Preço mora em `catalog_products.preco_cents`. As duas tabelas não têm FK
  entre si — hoje nada liga "tipo de consulta PLUS" ao "produto PLUS
  R$997". Confirmado nas migrations 0177 (agenda) e no baseline (catálogo).
- `automation_rules.trigger_event` aceita qualquer string no formato
  `algo.algo` (regex `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`), mas hoje só
  `lead.*` está exercitado em teste. Não confirmei se o motor de automação
  escuta evento novo sem código adicional — tratar como "provavelmente
  precisa de fiação manual", não como certeza.
- Conclusão: **não existe atalho.** Toda a cadeia é código novo — tabela,
  cliente de API, tool MCP, rota de webhook.

## O que a Nutricionista faz hoje (referência de comportamento, não de código)

Tool `pagamentos` (n8n, `AG Nutricionista`):
- Recebe `telefone`, `tipo_de_produto` (consulta/grupo/Comunidade),
  `nome_do_produto` (UP/PLUS/PREMIUM/Grupo de Emagrecimento/Comunidade Você
  mais Leve), `nome_completo`.
- Bloqueia se já pago (`STATUS FINANCEIRO = ✅ PAGO`).
- Bloqueia se faltar nome completo + data de nascimento no cadastro.
- Para `tipo_de_produto=consulta`: exige agendamento já feito — sem
  `calendar_appointments` correspondente, o backend recusa
  (`erro=SEM_CONSULTA_AGENDADA`).
- Link de grupo/comunidade não é copiado do histórico — sempre gera de novo
  (evita vazar link de cobrança antiga).
- Preços de referência (script antigo, conferir se ainda valem):
  UP R$450/30d, PLUS R$997/90d, PREMIUM R$1.997/210d, Grupo R$97,
  Comunidade R$67/mês.

Essas regras viram **instrução da tool nova**, não lógica hardcoded — mesmo
padrão do resto do MCP do DeskcommCRM (ver `lib/mcp/tools/comercio.ts` como
referência de estilo: comentário explicando por que a query filtra
`organization_id` manualmente).

## Plano — 4 peças

### 1. Migration nova: `payment_charges`
Tabela própria, não reaproveitar `orders`. Colunas mínimas:
`id, organization_id, contact_id, catalog_product_id (nullable),
appointment_id (nullable), provider ('asaas'), external_id (id da cobrança
no Asaas), status (pending/paid/cancelled/expired), amount_cents,
payment_url, paid_at, created_at`. RLS igual ao resto do schema
(`organization_id` como âncora, policy por org).

### 2. Cliente Asaas: `lib/pagamentos/asaas.ts`
Wrapper HTTP fino: criar cliente (customer), criar cobrança (charge/link de
pagamento), consultar status. Chave de API em variável de ambiente própria
(`ASAAS_API_KEY`, sandbox primeiro) — **não é a chave do Rafael, é a tua
conta Asaas**. Se o painel de credenciais (`ai_provider_credentials`) não
for o lugar certo por ser específico de IA, guardar em `.env` como o resto
do sistema já faz para segredo de canal único.

### 3. Tool MCP nova: `crm_generate_payment_link`
Segue o padrão de `lib/mcp/tools/comercio.ts` e `agendamento.ts`. Input:
`contact_id`, `catalog_product_id` (lê `preco_cents` de lá — fonte única de
preço, sem duplicar valor na tool), `appointment_id` opcional (pra aplicar a
regra "consulta exige agendamento feito" igual à MEG). Regras de bloqueio
(já pago, cadastro incompleto) viram checagem na própria tool, não na
descrição — a MEG aprendeu a duras penas que descrição sozinha o modelo
ignora sob pressão (ver bloco B1.8 do checklist dela: "nunca inventar
justificativa pra falha de tool").

### 4. Webhook de retorno: `app/api/v1/webhooks/asaas/route.ts`
Estrutura de rota espelha `app/api/v1/webhooks/waha/route.ts` — único webhook
inbound existente no repo, mesmo formato de `app/api/v1/webhooks/`. Recebe
evento do Asaas (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`), valida
token/assinatura, atualiza `payment_charges.status='paid'`, dispara
`crm_send_whatsapp_message` confirmando pro cliente. Pra v1, chamar o envio
direto no handler é mais simples e correto (regra ponytail: não construir
`automation_rules` genérico pra um evento só) — migrar pra automação depois
se aparecer um segundo gatilho que precise da mesma esteira.

## Ordem de implementação sugerida

1. Migration (`payment_charges`) — isolado, sem risco.
2. Cliente Asaas em sandbox, testado por script solto antes de virar tool.
3. Tool MCP, testada com `is_dry_run` (mecanismo que já existe em
   `ai_agent_runs`, visto no teste de 10/09).
4. Webhook, testado com payload de exemplo do Asaas (docs deles têm exemplo
   de `PAYMENT_CONFIRMED`).
5. Só then: sandbox → produção, trocar `ASAAS_API_KEY` sandbox pela real.

## Decisões pendentes (Marcelo decide, não é technical)

- Preço por plano: confirmar se R$450/997/1.997 ainda valem ou mudaram desde
  o script antigo da MEG.
- Onde amarrar `catalog_product_id` ↔ `calendar_event_types`: por nome
  (string igual) ou criar FK de verdade? FK é mais seguro, mas é migration
  extra — decidir se vale agora ou depois.
- Cobrar por PIX, boleto, cartão ou os três? Muda o payload de criação de
  cobrança no Asaas.

## Estado

Nada implementado. Este documento é o plano; próximo passo é escrever a
migration do item 1 quando o Marcelo autorizar.
