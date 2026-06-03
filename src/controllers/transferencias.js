const supabase = require('../lib/supabase')
const { registrar: registrarHistorico } = require('./historico')

async function listar(req, res) {
  const { status, limite = 50, pagina = 1, data_inicio, data_fim } = req.query
  const offset = (pagina - 1) * limite
  let query = supabase
    .from('transferencias')
    .select(`id, quantidade, quantidade_destino, unidade_destino, finalidade, status, observacao, motivo_rejeicao, solicitado_em, resolvido_em, produtos(id, sku, nome, unidade, unidade_insumo, fator_conversao, tipo), centro_origem:centros!centro_origem_id(id, nome, estoques(nome)), centro_destino:centros!centro_destino_id(id, nome, estoques(nome)), solicitante:usuarios!solicitante_id(id, nome), admin:usuarios!admin_id(id, nome)`, { count: 'exact' })
    .order('solicitado_em', { ascending: false })
    .range(offset, offset + Number(limite) - 1)
  if (req.usuario.papel === 'operador') query = query.eq('solicitante_id', req.usuario.id)
  if (status) query = query.eq('status', status)
  if (data_inicio) query = query.gte('solicitado_em', data_inicio)
  if (data_fim) query = query.lte('solicitado_em', data_fim)
  const { data, error, count } = await query
  if (error) return res.status(500).json({ erro: 'Erro ao listar transferencias' })
  return res.json({ dados: data, total: count, pagina: Number(pagina), limite: Number(limite) })
}

async function solicitar(req, res) {
  const { produto_id, centro_origem_id, centro_destino_id, quantidade, observacao, finalidade } = req.body
  if (!produto_id || !centro_origem_id || !centro_destino_id || !quantidade) {
    return res.status(400).json({ erro: 'produto_id, centro_origem_id, centro_destino_id e quantidade sao obrigatorios' })
  }
  if (centro_origem_id === centro_destino_id) return res.status(400).json({ erro: 'Centro de origem e destino devem ser diferentes' })
  if (Number(quantidade) <= 0) return res.status(400).json({ erro: 'Quantidade deve ser maior que zero' })

  const { data: produto } = await supabase
    .from('produtos').select('tipo, nome, unidade, unidade_insumo, fator_conversao').eq('id', produto_id).single()

  if (produto?.tipo === 'ambos' && !finalidade) {
    return res.status(400).json({ erro: 'Para produtos do tipo ambos, informe a finalidade: revenda ou materia_prima' })
  }

  const { data: posicao } = await supabase
    .from('posicoes_estoque').select('quantidade')
    .eq('produto_id', produto_id).eq('centro_id', centro_origem_id).single()

  const saldo = Number(posicao?.quantidade || 0)
  const qtdSolicitada = Number(quantidade)

  // Usa precisão de 4 casas decimais para evitar problema de arredondamento
  if (Math.round(saldo * 10000) < Math.round(qtdSolicitada * 10000)) {
    return res.status(422).json({
      erro: `Saldo insuficiente para "${produto?.nome || 'produto'}" no centro de origem. Disponivel: ${saldo} ${produto?.unidade_insumo || produto?.unidade || ''}`,
      saldo_disponivel: saldo,
      quantidade_solicitada: qtdSolicitada
    })
  }

  let quantidade_destino = qtdSolicitada
  let unidade_destino = produto?.unidade || 'un'
  if (finalidade === 'materia_prima' && produto?.fator_conversao && produto?.unidade_insumo) {
    quantidade_destino = qtdSolicitada * Number(produto.fator_conversao)
    unidade_destino = produto.unidade_insumo
  }

  const { data, error } = await supabase
    .from('transferencias')
    .insert({
      produto_id, centro_origem_id, centro_destino_id,
      solicitante_id: req.usuario.id,
      quantidade: qtdSolicitada,
      quantidade_destino, unidade_destino,
      finalidade: produto?.tipo === 'ambos' ? finalidade : null,
      observacao, status: 'pendente'
    })
    .select(`id, quantidade, quantidade_destino, unidade_destino, finalidade, status, observacao, solicitado_em, produtos(sku, nome, unidade, unidade_insumo, fator_conversao, tipo), centro_origem:centros!centro_origem_id(nome, estoques(nome)), centro_destino:centros!centro_destino_id(nome, estoques(nome))`)
    .single()

  if (error) return res.status(500).json({ erro: 'Erro ao solicitar transferencia' })
  await registrarHistorico(req.usuario.id, 'transferencias', data.id, 'criacao', null, { produto_id, centro_origem_id, centro_destino_id, quantidade: qtdSolicitada, status: 'pendente' })
  return res.status(201).json(data)
}

async function resolver(req, res) {
  const { id } = req.params
  const { acao, motivo_rejeicao } = req.body
  if (!['aprovar', 'rejeitar'].includes(acao)) return res.status(400).json({ erro: 'acao deve ser aprovar ou rejeitar' })

  const { data: transferencia, error: erroBusca } = await supabase
    .from('transferencias')
    .select('id, status, produto_id, centro_origem_id, centro_destino_id, quantidade, quantidade_destino, unidade_destino, finalidade')
    .eq('id', id).single()

  if (erroBusca || !transferencia) return res.status(404).json({ erro: 'Transferencia nao encontrada' })
  if (transferencia.status !== 'pendente') return res.status(409).json({ erro: 'Transferencia ja resolvida' })

  if (acao === 'aprovar') {
    const { data: movsExistentes } = await supabase
      .from('movimentacoes').select('id')
      .eq('documento', id).eq('tipo', 'saida')

    const jaMovimentou = movsExistentes && movsExistentes.length > 0

    if (!jaMovimentou) {
      const { data: posicao } = await supabase
        .from('posicoes_estoque').select('quantidade')
        .eq('produto_id', transferencia.produto_id)
        .eq('centro_id', transferencia.centro_origem_id).single()

      const saldoAtual = Number(posicao?.quantidade || 0)

      // Usa precisão de 4 casas decimais para evitar problema de arredondamento
      if (Math.round(saldoAtual * 10000) < Math.round(transferencia.quantidade * 10000)) {
        const { data: prod } = await supabase.from('produtos').select('nome').eq('id', transferencia.produto_id).single()
        return res.status(422).json({
          erro: `Saldo insuficiente para "${prod?.nome}" no momento da aprovacao. Disponivel: ${saldoAtual}`,
          saldo_disponivel: saldoAtual,
          quantidade_necessaria: transferencia.quantidade
        })
      }

      const { error: errSaida } = await supabase.from('movimentacoes').insert({
        produto_id: transferencia.produto_id,
        centro_id: transferencia.centro_origem_id,
        usuario_id: req.usuario.id,
        tipo: 'saida',
        quantidade: transferencia.quantidade,
        motivo: 'Transferencia aprovada #' + id,
        documento: id,
        finalidade: transferencia.finalidade
      })

      if (errSaida) {
        console.error('ERRO SAIDA TRANSFERENCIA:', JSON.stringify(errSaida))
        return res.status(500).json({ erro: 'Erro ao registrar saida da transferencia' })
      }

      const qtdEntrada = transferencia.quantidade_destino || transferencia.quantidade
      const { error: errEntrada } = await supabase.from('movimentacoes').insert({
        produto_id: transferencia.produto_id,
        centro_id: transferencia.centro_destino_id,
        usuario_id: req.usuario.id,
        tipo: 'entrada',
        quantidade: qtdEntrada,
        motivo: 'Transferencia aprovada #' + id,
        documento: id,
        finalidade: transferencia.finalidade,
        custo_unitario: null
      })

      if (errEntrada) {
        console.error('ERRO ENTRADA TRANSFERENCIA:', JSON.stringify(errEntrada))
        return res.status(500).json({ erro: 'Erro ao registrar entrada da transferencia' })
      }
    }
  }

  const novoStatus = acao === 'aprovar' ? 'aprovada' : 'rejeitada'
  const { data, error } = await supabase
    .from('transferencias')
    .update({
      status: novoStatus,
      admin_id: req.usuario.id,
      motivo_rejeicao: acao === 'rejeitar' ? motivo_rejeicao : null
    })
    .eq('id', id).select().single()

  if (error) return res.status(500).json({ erro: 'Erro ao processar transferencia' })
  await registrarHistorico(req.usuario.id, 'transferencias', id, 'edicao', { status: 'pendente' }, { status: novoStatus, motivo_rejeicao })
  return res.json({ mensagem: 'Transferencia ' + novoStatus + ' com sucesso', transferencia: data })
}

async function cancelar(req, res) {
  const { id } = req.params
  const { data: transferencia } = await supabase.from('transferencias').select('id, status, solicitante_id').eq('id', id).single()
  if (!transferencia) return res.status(404).json({ erro: 'Transferencia nao encontrada' })
  if (transferencia.status !== 'pendente') return res.status(409).json({ erro: 'So e possivel cancelar transferencias pendentes' })
  if (req.usuario.papel === 'operador' && transferencia.solicitante_id !== req.usuario.id) {
    return res.status(403).json({ erro: 'Sem permissao para cancelar esta transferencia' })
  }
  await supabase.from('transferencias').update({ status: 'cancelada' }).eq('id', id)
  await registrarHistorico(req.usuario.id, 'transferencias', id, 'edicao', { status: 'pendente' }, { status: 'cancelada' })
  return res.json({ mensagem: 'Transferencia cancelada' })
}

module.exports = { listar, solicitar, resolver, cancelar }
