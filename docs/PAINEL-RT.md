# Painel do Responsavel Tecnico

O portal do RT de Psicologia usa a autenticacao Firebase existente, mas mantem
uma sessao isolada das areas de paciente, instituicao e profissional.

## Liberacao de acesso

1. O RT precisa ter uma conta Firebase com o e-mail confirmado.
2. No ambiente do backend, defina `THERAPY_RT_EMAILS` com um ou mais e-mails
   separados por virgula.
3. Alternativamente, crie um documento ativo em `therapy_rt_assignments`:

```json
{
  "email": "rt@exemplo.com.br",
  "name": "Nome do responsavel tecnico",
  "crp": "04/00000",
  "active": true
}
```

E-mails presentes em `THERAPY_ADMIN_EMAILS` tambem podem acessar para validar
o painel antes da designacao definitiva do RT.

## Enderecos

- Entrada: `/rt-login.html`
- Painel: `/rt-painel.html`

## Escopo de dados

O painel apresenta:

- regularidade e identificacao profissional dos psicologos;
- quantidade agregada de atendimentos nos ultimos 30 dias;
- checklist de conformidade;
- registros de supervisao e orientacao tecnica;
- ocorrencias operacionais e suas providencias;
- trilha de auditoria das alteracoes feitas pelo RT.

Por desenho, as rotas do RT nao consultam prontuarios, notas clinicas,
mensagens, gravacoes ou nomes de pacientes. Uma ocorrencia tambem deve ser
descrita sem identificacao de paciente.

## Colecoes proprias

- `therapy_rt_assignments`
- `therapy_rt_compliance`
- `therapy_rt_incidents`
- `therapy_rt_supervisions`
- `therapy_rt_audit`

