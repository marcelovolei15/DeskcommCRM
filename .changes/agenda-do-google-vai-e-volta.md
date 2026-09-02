---
impacto: nada_mudou
secao: corrigido
titulo: O compromisso marcado no CRM chega ao Google Agenda, e o que está marcado lá aparece na tela
---

A conexão com o Google Agenda existia desde a versão que trouxe a Agenda, e os
dois lados dela estavam quebrados — em toda instalação, não em algumas.

Do CRM para o Google, nenhum compromisso jamais chegou: a cada cinco minutos o
sistema tentava publicar e o Google recusava, sempre pelo mesmo motivo, que era
descartado antes de chegar ao registro. Quem olhava só via `HTTP 400`, repetido
por horas, sem nada dizendo qual campo tinha sido recusado. O motivo agora é
guardado junto do erro, e a recusa em si deixou de acontecer.

Do Google para o CRM, o que a pessoa marcava no calendário dela bloqueava o
horário mas não era desenhado: a agenda aparecia vazia e o horário aparecia
indisponível ao mesmo tempo. Agora o bloco aparece na grade, na semana e no mês,
identificado apenas como "Ocupado" — o nome do compromisso particular continua
sem atravessar para a tela de trabalho, que é vista por quem gerencia.

Quem conecta a conta e recebe uma recusa do Google também passa a ler o que
fazer. Antes a tela dizia "Tente de novo" para um erro que não passa com o
tempo — quase sempre a API do Google Agenda desligada no projeto do Google Cloud
da instalação, coisa que só o dono resolve, e no Console, não repetindo o clique.

Para quem já roda numa VPS: nada a fazer. Nenhuma configuração nova, nenhum passo
de atualização, e quem não usa o Google Agenda não é afetado.
