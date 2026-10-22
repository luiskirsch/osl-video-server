# Instruções para agentes (Codex, Claude)

## Publicar o backend

Depois de cada push no branch `luiskirsch.github.io`, rode:

```powershell
npm run publicar
```

O push sozinho **não** publica. O workflow "Imagem do backend" monta uma imagem
por commit e o comando a entrega ao Railway: publica no staging, confere o
`/health` e só então publica na produção. Ao terminar, confirme que
`https://api.espacopreludio.com.br/health` mostra o commit publicado.

O dono do projeto delegou essa etapa aos agentes: não peça confirmação. Se o
login do Railway tiver expirado, o comando avisa; peça ao usuário para rodar
`railway login`. Detalhes e alternativas em `LOCAL-SETUP.md`.
