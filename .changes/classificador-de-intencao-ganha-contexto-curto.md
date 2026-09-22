---
impacto: nada_mudou
secao: corrigido
titulo: O classificador de intenção do roteador para de trocar de agente no meio de um fluxo por causa de resposta curta
---

Com um agente "grudado" (sticky) na conversa — por exemplo, o de Agendamento,
no meio de uma coleta de dados —, uma resposta curta e ambígua do lead
("Primeira", "sim", "essa mesma") podia ser reclassificada para outra
intenção com confiança suficiente pra trocar de agente, porque o
classificador via só aquela mensagem isolada, sem a pergunta que ela
respondia. O atendimento saía do fluxo de agendamento no meio da conversa,
sem avisar ninguém.

O classificador agora recebe também as últimas mensagens da conversa (não o
histórico inteiro) só pra desambiguar respostas curtas — continua rodando a
cada turno, com o mesmo custo por chamada de antes. Quem não usa o roteador
por intenção não é afetado.
