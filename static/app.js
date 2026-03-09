const STORAGE_KEY = 'ai_short_drama_state_v1';

function bind(id) {
  return document.getElementById(id);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { story_card: null, workshop: null, storyboard: null };
    }
    const parsed = JSON.parse(raw);
    return {
      story_card: parsed.story_card || null,
      workshop: parsed.workshop || null,
      storyboard: parsed.storyboard || null,
    };
  } catch (err) {
    return { story_card: null, workshop: null, storyboard: null };
  }
}

const state = loadState();

let relationshipNetwork = null;
let timelineSortable = null;
let selectedRelationIndex = null;
let draftRelationNodes = [];
let videoPollTimer = null;
const VIDEO_POLL_INTERVAL_MS = 15000;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function updateOutput(id, text) {
  const target = bind(id);
  if (target) {
    target.textContent = text;
  }
}

function hasDataForExport() {
  return Boolean(state.story_card || state.workshop || state.storyboard);
}

function getVideoState() {
  if (!state.video_lab) {
    state.video_lab = {
      script: '',
      prompt: '',
      task_id: '',
      task_status: '',
      video_url: '',
      auto_poll: true,
      last_check_time: '',
    };
  }
  return state.video_lab;
}

function stopVideoPolling(notify = true) {
  if (videoPollTimer) {
    clearInterval(videoPollTimer);
    videoPollTimer = null;
    if (notify) {
      const video = getVideoState();
      const text = `Task ID: ${video.task_id || '-'}\n状态: ${video.task_status || 'UNKNOWN'}\n自动轮询已停止。`;
      updateOutput('video-task-output', text);
    }
  }
}

async function queryVideoTaskOnce({ silent = false } = {}) {
  const video = getVideoState();
  if (!video.task_id) {
    if (!silent) {
      updateOutput('video-task-output', '请先创建视频任务。');
    }
    return;
  }

  if (!silent) {
    updateOutput('video-task-output', `正在查询任务 ${video.task_id} ...`);
  }

  const data = await fetchJson(`/api/video/task/${video.task_id}`, { method: 'GET' });
  if (!data.ok) {
    updateOutput('video-task-output', `错误: ${data.error}\n${data.detail || ''}`);
    stopVideoPolling(false);
    return;
  }

  const output = data.result?.output || {};
  video.task_status = output.task_status || 'UNKNOWN';
  video.video_url = output.video_url || output.url || '';
  video.last_check_time = new Date().toLocaleString();
  saveState();

  let text = `Task ID: ${video.task_id}\n状态: ${video.task_status}`;
  text += `\n最近查询: ${video.last_check_time}`;

  if (video.video_url) {
    text += '\n视频URL已生成。';
    renderVideoResult(video.video_url);
  }

  if (video.task_status === 'SUCCEEDED' || video.task_status === 'FAILED' || video.task_status === 'CANCELED') {
    stopVideoPolling(false);
    text += '\n任务已结束，自动轮询已停止。';
  } else if (videoPollTimer) {
    text += '\n自动轮询中（15秒/次）。';
  }

  updateOutput('video-task-output', text);
}

function startVideoPolling() {
  const video = getVideoState();
  if (!video.task_id) {
    return;
  }

  stopVideoPolling(false);
  videoPollTimer = setInterval(() => {
    queryVideoTaskOnce({ silent: true }).catch((err) => {
      updateOutput('video-task-output', `错误: ${err.message}`);
      stopVideoPolling(false);
    });
  }, VIDEO_POLL_INTERVAL_MS);
}

async function runStage(stage, payload) {
  const resp = await fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, payload }),
  });
  return resp.json();
}

async function downloadFile(url, filename, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  });

  if (!resp.ok) {
    let errMsg = '导出失败';
    try {
      const errJson = await resp.json();
      errMsg = errJson.error || errMsg;
    } catch (e) {
      // Ignore parse error and keep generic message.
    }
    throw new Error(errMsg);
  }

  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

function setRelationStatus(text) {
  const tip = bind('rel-status');
  if (tip) {
    tip.textContent = text;
  }
}

function setRelationSelection(from, to, type = '', tension = '') {
  const fromInput = bind('rel-from-display');
  const toInput = bind('rel-to-display');
  const typeInput = bind('rel-type');
  const tensionInput = bind('rel-tension');
  if (!fromInput || !toInput || !typeInput || !tensionInput) {
    return;
  }

  fromInput.value = from || '';
  toInput.value = to || '';
  typeInput.value = type || '';
  tensionInput.value = tension || '';
}

function renderRelationshipGraph() {
  const container = bind('relationship-graph');
  if (!container) {
    return;
  }

  if (typeof vis === 'undefined') {
    container.innerHTML = '<div class="hint" style="padding:12px;">未加载图谱依赖，请刷新页面。</div>';
    return;
  }

  const characters = state.workshop?.characters || [];
  const relationships = state.workshop?.relationships || [];

  if (!characters.length) {
    container.innerHTML = '<div class="hint" style="padding:12px;">请先在创作工坊生成角色与情节。</div>';
    relationshipNetwork = null;
    selectedRelationIndex = null;
    draftRelationNodes = [];
    setRelationSelection('', '', '', '');
    setRelationStatus('请先生成角色数据。');
    return;
  }

  const nodes = characters.map((c, idx) => ({
    id: c.name || `角色${idx + 1}`,
    label: c.name || `角色${idx + 1}`,
    title: (c.tags || []).join(' / ') || '无标签',
    shape: 'dot',
    size: 20,
  }));

  const edges = relationships
    .map((r, idx) => ({ rel: r, idx }))
    .filter((item) => item.rel.from && item.rel.to)
    .map((item) => ({
      id: `rel-${item.idx}`,
      from: item.rel.from,
      to: item.rel.to,
      label: item.rel.type || '关系',
      title: item.rel.tension || '',
      arrows: 'to',
      smooth: true,
      width: selectedRelationIndex === item.idx ? 3 : 1,
      color: selectedRelationIndex === item.idx ? '#b84f10' : '#8f735e',
    }));

  const data = {
    nodes: new vis.DataSet(nodes),
    edges: new vis.DataSet(edges),
  };

  const options = {
    autoResize: true,
    interaction: { hover: true },
    nodes: {
      color: {
        background: '#eec9a9',
        border: '#b86a36',
        highlight: { background: '#ffd7b8', border: '#a94f14' },
      },
      font: { color: '#2b2119', size: 13 },
    },
    edges: {
      color: '#8f735e',
      font: { align: 'top', color: '#3b2f27', size: 12 },
    },
    physics: {
      solver: 'forceAtlas2Based',
      stabilization: { iterations: 80 },
    },
  };

  if (!relationshipNetwork) {
    relationshipNetwork = new vis.Network(container, data, options);
    relationshipNetwork.on('click', (params) => {
      if (!state.workshop) {
        return;
      }

      if (params.edges.length > 0) {
        const edgeId = String(params.edges[0]);
        const idx = Number(edgeId.replace('rel-', ''));
        const rel = state.workshop.relationships?.[idx];
        if (Number.isInteger(idx) && rel) {
          selectedRelationIndex = idx;
          draftRelationNodes = [];
          setRelationSelection(rel.from, rel.to, rel.type || '', rel.tension || '');
          setRelationStatus(`已选中关系：${rel.from} -> ${rel.to}`);
          renderRelationshipGraph();
        }
        return;
      }

      if (params.nodes.length > 0) {
        const nodeName = String(params.nodes[0]);
        selectedRelationIndex = null;
        draftRelationNodes.push(nodeName);
        if (draftRelationNodes.length > 2) {
          draftRelationNodes = draftRelationNodes.slice(-2);
        }

        if (draftRelationNodes.length === 1) {
          setRelationSelection(draftRelationNodes[0], '', '', '');
          setRelationStatus(`已选择起点：${draftRelationNodes[0]}。请再选终点。`);
        } else {
          setRelationSelection(draftRelationNodes[0], draftRelationNodes[1], '关系', '');
          setRelationStatus(`已选择关系端点：${draftRelationNodes[0]} -> ${draftRelationNodes[1]}`);
        }
        return;
      }

      selectedRelationIndex = null;
      draftRelationNodes = [];
      setRelationStatus('点击连线编辑；或依次点击两个角色节点创建关系。');
    });
  } else {
    relationshipNetwork.setData(data);
  }
}

function getOrderedPlotNodes() {
  const plotNodes = state.workshop?.plot_nodes || [];
  const idMap = new Map(plotNodes.map((node) => [node.id, node]));
  const view = state.workshop?.timeline_view || [];

  const ordered = [];
  view.forEach((id) => {
    if (idMap.has(id)) {
      ordered.push(idMap.get(id));
      idMap.delete(id);
    }
  });
  idMap.forEach((node) => ordered.push(node));
  return ordered;
}

function syncTimelineToState() {
  if (!state.workshop) {
    return;
  }
  const list = bind('timeline-list');
  if (!list) {
    return;
  }

  const ids = Array.from(list.querySelectorAll('.timeline-card')).map((li) => li.dataset.nodeId);
  state.workshop.timeline_view = ids;

  const current = new Map((state.workshop.plot_nodes || []).map((node) => [node.id, node]));
  state.workshop.plot_nodes = ids.map((id) => current.get(id)).filter(Boolean);
  saveState();
}

function renderTimeline() {
  const list = bind('timeline-list');
  if (!list) {
    return;
  }

  const ordered = getOrderedPlotNodes();
  if (!ordered.length) {
    list.innerHTML = '<li class="hint">请先在创作工坊生成情节节点。</li>';
    return;
  }

  list.innerHTML = ordered
    .map(
      (node, idx) => `
      <li class="timeline-card" data-node-id="${node.id || `N${idx + 1}`}">
        <div class="meta">${idx + 1}. ${node.id || ''}</div>
        <div class="title">${node.template_stage || '剧情节点'}</div>
        <div class="summary">${node.summary || ''}</div>
      </li>
    `,
    )
    .join('');

  if (!timelineSortable && typeof Sortable !== 'undefined') {
    timelineSortable = new Sortable(list, {
      animation: 180,
      ghostClass: 'timeline-dragging',
      onEnd: () => {
        syncTimelineToState();
      },
    });
  }
}

function refreshVisualEditors() {
  renderRelationshipGraph();
  renderTimeline();
}

function bindWorkshopActions() {
  const btnStory = bind('btn-story');
  if (btnStory) {
    btnStory.addEventListener('click', async () => {
      updateOutput('story-output', '生成中...');
      const payload = {
        idea: bind('idea')?.value.trim() || '',
        theme: bind('theme')?.value.trim() || '',
        tone: bind('tone')?.value.trim() || '',
        structure: bind('structure')?.value.trim() || '',
      };

      const data = await runStage('story_engine', payload);
      if (!data.ok) {
        updateOutput('story-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      state.story_card = data.result.story_card;
      saveState();
      updateOutput('story-output', pretty(data.result));
    });
  }

  const btnWorkshop = bind('btn-workshop');
  if (btnWorkshop) {
    btnWorkshop.addEventListener('click', async () => {
      updateOutput('workshop-output', '生成中...');
      const payload = {
        story_card: state.story_card,
        role_requirements: bind('role-req')?.value.trim() || '',
        plot_requirements: bind('plot-req')?.value.trim() || '',
      };

      const data = await runStage('workshop', payload);
      if (!data.ok) {
        updateOutput('workshop-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      state.workshop = data.result;
      saveState();
      updateOutput('workshop-output', pretty(data.result));
      refreshVisualEditors();
    });
  }

  const btnStoryboard = bind('btn-storyboard');
  if (btnStoryboard) {
    btnStoryboard.addEventListener('click', async () => {
      updateOutput('storyboard-output', '生成中...');
      const payload = {
        workshop: state.workshop,
        visual_style: bind('visual-style')?.value.trim() || '',
      };

      const data = await runStage('storyboard', payload);
      if (!data.ok) {
        updateOutput('storyboard-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      state.storyboard = data.result;
      saveState();
      updateOutput('storyboard-output', pretty(data.result));
    });
  }

  const btnCommand = bind('btn-command');
  if (btnCommand) {
    btnCommand.addEventListener('click', async () => {
      updateOutput('command-output', '执行中...');
      const payload = {
        command: bind('command')?.value.trim() || '',
        project_state: {
          story_card: state.story_card,
          workshop: state.workshop,
          storyboard: state.storyboard,
        },
      };

      const data = await runStage('command', payload);
      if (!data.ok) {
        updateOutput('command-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      if (data.result.updated_state) {
        state.story_card = data.result.updated_state.story_card || state.story_card;
        state.workshop = data.result.updated_state.workshop || state.workshop;
        state.storyboard = data.result.updated_state.storyboard || state.storyboard;
        saveState();
        refreshVisualEditors();
      }

      updateOutput('command-output', pretty(data.result));
    });
  }
}

function bindVisualActions() {
  const btnRelSave = bind('btn-rel-save');
  if (btnRelSave) {
    btnRelSave.addEventListener('click', () => {
      if (!state.workshop) {
        setRelationStatus('请先在创作工坊生成角色与情节。');
        return;
      }

      const from = bind('rel-from-display')?.value.trim() || '';
      const to = bind('rel-to-display')?.value.trim() || '';
      const type = bind('rel-type')?.value.trim() || '关系';
      const tension = bind('rel-tension')?.value.trim() || '';

      if (!from || !to) {
        setRelationStatus('请先在关系图上选择关系。');
        return;
      }

      state.workshop.relationships = state.workshop.relationships || [];
      const idx =
        selectedRelationIndex !== null
          ? selectedRelationIndex
          : state.workshop.relationships.findIndex((r) => r.from === from && r.to === to);

      const rel = { from, to, type, tension };
      if (idx >= 0) {
        state.workshop.relationships[idx] = rel;
        setRelationStatus(`已更新关系：${from} -> ${to}`);
      } else {
        state.workshop.relationships.push(rel);
        selectedRelationIndex = state.workshop.relationships.length - 1;
        setRelationStatus(`已新增关系：${from} -> ${to}`);
      }

      draftRelationNodes = [];
      saveState();
      refreshVisualEditors();
    });
  }

  const btnRelRemove = bind('btn-rel-remove');
  if (btnRelRemove) {
    btnRelRemove.addEventListener('click', () => {
      if (!state.workshop?.relationships) {
        return;
      }

      const from = bind('rel-from-display')?.value.trim() || '';
      const to = bind('rel-to-display')?.value.trim() || '';

      if (selectedRelationIndex !== null && state.workshop.relationships[selectedRelationIndex]) {
        const rel = state.workshop.relationships[selectedRelationIndex];
        state.workshop.relationships.splice(selectedRelationIndex, 1);
        setRelationStatus(`已删除关系：${rel.from} -> ${rel.to}`);
      } else {
        state.workshop.relationships = state.workshop.relationships.filter((r) => !(r.from === from && r.to === to));
        setRelationStatus(`已删除关系：${from} -> ${to}`);
      }

      selectedRelationIndex = null;
      draftRelationNodes = [];
      setRelationSelection('', '', '', '');
      saveState();
      refreshVisualEditors();
    });
  }
}

function bindExportActions() {
  const btnExport = bind('btn-export');
  if (btnExport) {
    btnExport.addEventListener('click', async () => {
      if (!hasDataForExport()) {
        updateOutput('export-output', '暂无可导出数据，请先去创作工坊生成内容。');
        return;
      }

      updateOutput('export-output', '导出中...');
      const payload = {
        story_card: state.story_card,
        workshop: state.workshop,
        storyboard: state.storyboard,
      };

      const data = await runStage('export', payload);
      if (!data.ok) {
        updateOutput('export-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      updateOutput('export-output', data.result.markdown);
    });
  }

  const btnDocx = bind('btn-export-docx');
  if (btnDocx) {
    btnDocx.addEventListener('click', async () => {
      if (!hasDataForExport()) {
        updateOutput('export-output', '暂无可导出数据，请先去创作工坊生成内容。');
        return;
      }

      updateOutput('export-output', '正在生成 Word 文件...');
      try {
        await downloadFile('/api/export/docx', 'ai_short_drama_export.docx', {
          story_card: state.story_card,
          workshop: state.workshop,
          storyboard: state.storyboard,
        });
        updateOutput('export-output', 'Word 导出成功，已开始下载。');
      } catch (err) {
        updateOutput('export-output', `错误: ${err.message}`);
      }
    });
  }

  const btnPdf = bind('btn-export-pdf');
  if (btnPdf) {
    btnPdf.addEventListener('click', async () => {
      if (!hasDataForExport()) {
        updateOutput('export-output', '暂无可导出数据，请先去创作工坊生成内容。');
        return;
      }

      updateOutput('export-output', '正在生成 PDF 文件...');
      try {
        await downloadFile('/api/export/pdf', 'ai_short_drama_export.pdf', {
          story_card: state.story_card,
          workshop: state.workshop,
          storyboard: state.storyboard,
        });
        updateOutput('export-output', 'PDF 导出成功，已开始下载。');
      } catch (err) {
        updateOutput('export-output', `错误: ${err.message}`);
      }
    });
  }
}

function restoreOutputsOnPageLoad() {
  if (bind('story-output') && state.story_card) {
    updateOutput('story-output', pretty({ story_card: state.story_card }));
  }
  if (bind('workshop-output') && state.workshop) {
    updateOutput('workshop-output', pretty(state.workshop));
  }
  if (bind('storyboard-output') && state.storyboard) {
    updateOutput('storyboard-output', pretty(state.storyboard));
  }
  if (bind('export-output') && hasDataForExport()) {
    updateOutput('export-output', '已检测到可导出的本地数据。');
  }

  const video = getVideoState();
  if (bind('video-script-output') && video.script) {
    updateOutput('video-script-output', video.script);
  }
  if (bind('video-prompt') && video.prompt) {
    bind('video-prompt').value = video.prompt;
  }
  if (bind('video-task-output') && video.task_id) {
    updateOutput('video-task-output', `最近任务: ${video.task_id}\n状态: ${video.task_status || 'UNKNOWN'}`);
  }
  if (bind('video-auto-poll')) {
    bind('video-auto-poll').checked = Boolean(video.auto_poll);
  }
  if (video.video_url) {
    renderVideoResult(video.video_url);
  }

  if (
    bind('video-auto-poll') &&
    video.task_id &&
    video.auto_poll &&
    !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(video.task_status || '')
  ) {
    startVideoPolling();
  }
}

function renderVideoResult(url) {
  const wrap = bind('video-result-wrap');
  const player = bind('video-result-player');
  const text = bind('video-result-link');
  if (!wrap || !player || !text) {
    return;
  }
  wrap.style.display = 'block';
  player.src = url;
  text.textContent = `视频链接(24小时内有效): ${url}`;
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  return data;
}

function extractPromptFromScript(scriptText) {
  const marker = '视频生成提示词';
  const idx = scriptText.indexOf(marker);
  if (idx < 0) {
    return scriptText.slice(0, 600);
  }
  return scriptText.slice(idx).replace(/^.*?[:：]/, '').trim();
}

function bindVideoActions() {
  const btnScript = bind('btn-video-script');
  if (btnScript) {
    btnScript.addEventListener('click', async () => {
      updateOutput('video-script-output', '正在让千问生成短剧脚本...');

      const payload = {
        idea: bind('video-idea')?.value.trim() || '',
        genre: bind('video-genre')?.value.trim() || '',
        roles: bind('video-roles')?.value.trim() || '',
        style: bind('video-style')?.value.trim() || '',
        duration_sec: Number(bind('video-duration')?.value || 10),
      };

      const data = await fetchJson('/api/video/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });

      if (!data.ok) {
        updateOutput('video-script-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      const video = getVideoState();
      video.script = data.script;
      video.prompt = extractPromptFromScript(data.script);
      saveState();

      updateOutput('video-script-output', data.script);
      if (bind('video-prompt')) {
        bind('video-prompt').value = video.prompt;
      }
    });
  }

  const btnCreate = bind('btn-video-create');
  if (btnCreate) {
    btnCreate.addEventListener('click', async () => {
      updateOutput('video-task-output', '正在创建视频任务...');

      const payload = {
        prompt: bind('video-prompt')?.value.trim() || '',
        model: bind('video-model')?.value.trim() || 'wan2.6-t2v',
        size: bind('video-size')?.value.trim() || '1280*720',
        duration: Number(bind('video-duration-task')?.value || 10),
        prompt_extend: true,
      };

      const data = await fetchJson('/api/video/create-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });

      if (!data.ok) {
        updateOutput('video-task-output', `错误: ${data.error}\n${data.detail || ''}`);
        return;
      }

      const output = data.result?.output || {};
      const video = getVideoState();
      video.prompt = payload.prompt;
      video.task_id = output.task_id || '';
      video.task_status = output.task_status || 'PENDING';
      video.video_url = '';
      video.last_check_time = '';
      video.auto_poll = Boolean(bind('video-auto-poll')?.checked);
      saveState();

      updateOutput('video-task-output', `任务已创建\nTask ID: ${video.task_id}\n状态: ${video.task_status}`);

      if (video.auto_poll && video.task_id) {
        startVideoPolling();
        queryVideoTaskOnce({ silent: true }).catch((err) => {
          updateOutput('video-task-output', `错误: ${err.message}`);
          stopVideoPolling(false);
        });
      }
    });
  }

  const btnRefresh = bind('btn-video-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      await queryVideoTaskOnce();
    });
  }

  const autoPollCheck = bind('video-auto-poll');
  if (autoPollCheck) {
    autoPollCheck.addEventListener('change', () => {
      const video = getVideoState();
      video.auto_poll = autoPollCheck.checked;
      saveState();
      if (!video.auto_poll) {
        stopVideoPolling(false);
      } else if (video.task_id && !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(video.task_status || '')) {
        startVideoPolling();
      }
    });
  }

  const btnStopPoll = bind('btn-video-stop-poll');
  if (btnStopPoll) {
    btnStopPoll.addEventListener('click', () => {
      stopVideoPolling(true);
    });
  }
}

bindWorkshopActions();
bindVisualActions();
bindExportActions();
bindVideoActions();
restoreOutputsOnPageLoad();
refreshVisualEditors();
