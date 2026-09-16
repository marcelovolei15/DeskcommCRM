# Detecção de STOP/opt-out — histórico e prova

> Movido do `CLAUDE.md` em 2026-09-15 (auditoria Prumo). A regra prática ficou
> lá, curta; a história e a prova de por que a regra é assim ficam aqui.

A regra mora em `lib/opt-out/deteccao.ts` e é a MESMA nos dois lados — a
ingestão (que grava `is_blocked=true`) e o runtime do agente.

**Não é mais a palavra solta.** Só bloqueia palavra ISOLADA (mensagem inteira =
a palavra) ou verbo de cessação com OBJETO DE COMUNICAÇÃO ("parar de me
mandar", "sair da lista"). Enquanto eram duas regras, a ingestão bloqueava
paciente que perguntou "tem como parar a dor?" — medido em clínica, 12 falsos
positivos num corpus de 32 frases de nicho.

**Cobre português e espanhol, nos dois níveis** (inequívoco e ambíguo) — foi
preciso um PR além do #275 (que só tinha coberto o vocabulário inequívoco) para
o espanhol ganhar a camada ambígua e as construções com pronome preso
("escribirme").

Para ver o vocabulário em vigor sem confiar nesta linha:
`grep -n 'PALAVRAS_DE_OPT_OUT' -A20 lib/opt-out/deteccao.ts`, e as frases de
controle em `tests/unit/opt-out-deteccao.test.ts`.
