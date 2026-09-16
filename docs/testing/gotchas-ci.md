# Gotchas de testes e CI

> Movido do `CLAUDE.md` em 2026-09-15 (auditoria Prumo: arquivo passava de 2,5x
> o orçamento de contexto). O checklist prático ficou lá; o histórico/prova de
> cada armadilha mora aqui.

## `test:unit` NÃO é `tests/unit/`

O script é `vitest run` **sem caminho**, e ele alcança o repositório inteiro — os
testes co-localizados em `lib/`, `app/`, `components/` e `hooks/` inclusive.
Medido em 2026-08-28: `vitest run` alcança **566 arquivos**; `tests/unit/` tem
**388**. Os 178 de fora são 133 em `lib/`, 37 em `app/`, 3 em `components/`, 1
em `hooks/` e 4 em `tests/`.

Quem lê o nome do script e roda `vitest run tests/unit` obtém um **verde menor
e mais fácil** sem perceber que obteve — e foi o que aconteceu num PR: a suíte
foi reportada como verde, e o que estava verde era o recorte. O comando que
vale é `pnpm test:unit`, sem caminho.

## Duas armadilhas irmãs, as duas pagas no mesmo dia

- **Gate escolhido não é suíte.** `typecheck`, `lint`, `lint:channels` e os
  arquivos de cerca podem estar todos verdes enquanto a suíte tem 17 falhas —
  nenhum deles toca o arquivo que quebrou. Antes de abrir PR, rode a suíte, não
  os gates que você lembra.
- **Não corte a saída.** `| tail -8` guarda o rodapé e joga fora os NOMES dos
  arquivos que falharam, que é o único dado que permite reconciliar depois.
  Redirecione e filtre:

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
  novo, em vez de acreditar no silêncio. (Comparar contra `Test Files` dá
  divergência falsa: `2 failed` de arquivos contra `7` de casos parece defeito
  da sonda e é só régua trocada.)

## Vermelho local que NÃO é seu

`lib/ai/dispatcher/rate-limit.test.ts` falha em 5 casos, com 15s de timeout
cada, quando o `.env.local` tem `UPSTASH_REDIS_REST_URL`/`TOKEN` e o Redis para
o qual eles apontam **não está de pé** (neste repo é o `serverless-redis-http`
local, não a nuvem). O `tests/setup/vitest.setup.ts` carrega o `.env.local`
para dentro do `process.env`, e o módulo só usa o contador em memória quando
essas variáveis estão **ausentes**. Provado nos dois sentidos. No CI não há
`UPSTASH` nenhum, então lá o caminho é o contador em memória e o arquivo passa.

## Invariantes não estão no `test:unit`

`vitest.config.ts` exclui `tests/invariants/**` de propósito: essa suíte
precisa de um Postgres real e roda via `vitest.db.config.ts`, orquestrada por
`scripts/test-db.sh`. Rodar só `pnpm test:unit` e concluir "está tudo verde" é
um falso verde — o isolamento RLS não foi exercitado.

## Checks obrigatórios — detalhe de cada um

- **`verify`** (`ci.yml`) — typecheck + lint + test:unit.
- **`invariants`** (`ci.yml`) — `pnpm test:db`: sobe `pgvector/pgvector:pg17`,
  aplica `supabase/baseline.sql` em modo install (`ON_ERROR_STOP=1`) e update
  (idempotência), e roda os testes de invariante, incluindo o de isolamento RLS
  entre 2 organizações.
- **`build-and-size`** (`perf.yml`) — `pnpm build` em Node 22.
- **`e2e`** (`e2e.yml`) — sobe Supabase local, aplica o `baseline.sql` e roda
  **todas as specs Playwright menos uma**. O número saiu daqui de propósito:
  ele apodreceu **cinco** vezes (a quinta em 2026-08-24, quando
  `inbox-quem-manda.spec.ts` entrou), e a condição que o PR #242 pôs para parar
  de recontar já tinha vencido na quarta. Quem precisa do número roda o
  comando abaixo — comando não envelhece. A **única** de fora é
  `vps-fresh-onboarding` (precisa de WAHA + Redis + Resend + Nuvemshop) — e ela
  é a **P0** da doutrina de QA Visual, ou seja, `e2e` verde **não** prova a
  jornada de instalação fresca, que é o produto que se vende.

  **Não confie em `grep` no arquivo inteiro.**
  `grep -oE '[a-z0-9-]+\.spec\.ts' .github/workflows/e2e.yml | sort -u | wc -l`
  conta quem é CITADO, não quem é INVOCADO: a `FORA_DO_CI` é uma variável YAML
  como as outras e entra na conta. (Até 2026-08-14 este parágrafo culpava
  "menções em comentários", e isso é falso — medido, o conjunto de specs
  citadas fora de variável é **vazio**.) O que roda são as `SPECS_PARTE_*`:

  ```bash
  ls tests/e2e/*.spec.ts | wc -l                    # quantas existem
  python3 - <<'PY'                                  # quantas o CI invoca
  import re
  y = open(".github/workflows/e2e.yml", encoding="utf-8").read()
  print(len({s for _, c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)', y)
               for s in re.findall(r'[a-z0-9-]+\.spec\.ts', c)}))
  PY
  ```

  **Por que não há mais número aqui.** O conserto que este parágrafo pedia era
  pôr a prosa sob gate — `tests/unit/e2e-cobertura-completa.test.ts` cobrando
  também o texto daqui. Tirar o número é melhor e mais barato: não há o que
  policiar, e a diferença entre disco e CI segue vigiada onde importa, no
  próprio teste, que reprova toda spec nova que não esteja em `SPECS_PARTE_*`
  ou em `FORA_DO_CI` **com motivo escrito**. Prosa que nenhum gate lê é prosa
  que diverge; prosa que não afirma número não tem como divergir.
- **`imagens-ok`** (`publish-image.yml`) — reprova quando qualquer uma das três
  imagens Docker não constrói. **É obrigatório desde 2026-08-13**.

Duas correções que este histórico já pagou: o `e2e` entrou para a lista depois
de o arquivo ser escrito, e a versão anterior dizia que ele "ainda não é
obrigatório"; depois o `imagens-ok` entrou e o arquivo seguiu dizendo "quatro".
Uma triagem que leia qualquer uma dessas versões mede contra a régua errada —
que é o modo de falha nº 1 do procedimento de triagem. **Reconfira na fonte
antes de confiar em qualquer lista**, com:

```console
$ gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
verify, build-and-size, invariants, e2e, imagens-ok
```
