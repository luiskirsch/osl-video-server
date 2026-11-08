# Instruções para agentes (Codex, Claude)

## Publicar o backend

Depois de cada push no branch `luiskirsch.github.io`, rode:

```powershell
npm run publicar
```

O push sozinho **não** publica. O workflow "Imagem do backend" monta uma imagem
por commit e o comando a entrega ao Railway: publica no staging, confere o
`/health` e só então publica na produção. Ao terminar, confirme que
`/health` público responde apenas `{"ok":true}`. O comando confirma o commit
em `/internal/health`, com token temporário de escopo `health:read` e credencial
obtida do ambiente Railway. Nunca exponha essa credencial ou o commit no health público.

O dono do projeto delegou essa etapa aos agentes: não peça confirmação. Se o
login do Railway tiver expirado, o comando avisa; peça ao usuário para rodar
`railway login`. Detalhes e alternativas em `LOCAL-SETUP.md`.
