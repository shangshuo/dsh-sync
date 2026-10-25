/**
 * Client half: the "同步" page inside Settings (0.4 UI).
 *
 * Loaded as a plain browser module (no build step). It talks to the Host through
 * `/dsh-sync/api`, which the Host plugin registers on the same web server.
 *
 * Layout: a permanent status header (one glance = "am I synced?") + three tabs
 * (备份 / 恢复 / 高级). Every action renders its result directly below the
 * buttons that triggered it, so feedback is never outside the viewport.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/dsh-sync/api';
    const KIND_LABEL = { s3: 'S3 兼容', webdav: 'WebDAV', local: '本地目录', none: '未配置' };
    const DOTS = '••••••••';

    const RULES = [
      { text: '至少 8 位', test: (value) => value.length >= 8 },
      { text: '包含小写字母', test: (value) => /[a-z]/.test(value) },
      { text: '包含大写字母', test: (value) => /[A-Z]/.test(value) },
      { text: '包含数字', test: (value) => /[0-9]/.test(value) },
      { text: '至少 1 个特殊符号（@ # $ * - _）', test: (value) => /[@#$*\-_]/.test(value) },
      { text: '只能使用字母、数字和 @ # $ * - _', test: (value) => /^[A-Za-z0-9@#$*\-_]*$/.test(value) },
    ];

    const PRIVACY_NOTICE =
      '该模块的文件可能包含 API 密钥或服务器访问令牌。这些内容不会被上传到任何第三方：文件在本机读取后整体加密（scrypt 派生密钥），' +
      '离开设备的只有密文——插件作者与云端存储都无法解密。凭证文件会在本机按规则剔除设备绑定记录后再入包（剔除过程不出本机）。' +
      '恢复时同样只在解密后写回本机。插件本身没有任何遥测或内容上报。请确保口令足够强，并自行保管好口令。';

    function describeChar(char) {
      if (char === ' ') return '空格';
      if (char === '\t') return '制表符';
      if (char === '\n') return '换行';
      return `「${char}」(U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`;
    }

    function invalidChars(value) {
      const seen = new Set();
      const list = [];
      for (const char of String(value ?? '')) {
        if (/[A-Za-z0-9@#$*\-_]/.test(char) || seen.has(char)) continue;
        seen.add(char);
        list.push(char);
      }
      return list;
    }

    /** Missing rules plus illegal characters, phrased as the user reads them. */
    function ruleErrors(value) {
      const missing = RULES.filter((rule) => !rule.text.startsWith('只能使用') && !rule.test(value)).map((rule) => rule.text);
      const invalid = invalidChars(value);
      const parts = [];
      if (missing.length > 0) parts.push(`还缺：${missing.join('、')}`);
      if (invalid.length > 0) parts.push(`不允许的字符：${invalid.map(describeChar).join('、')}`);
      return parts;
    }

    async function call(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-sync': '1' },
        body: JSON.stringify({ action, payload }),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        if (response.status === 405 || response.status === 404) {
          throw new Error(
            `Host 接口未就绪（HTTP ${response.status}）。通常是 Host 插件没有激活，或 DSH 还没重启：请完全退出 DSH 再打开；仍然报错请查看 ~/.dsh/dsh-sync/sync.log，并确认插件列表里本插件处于“已启用”。`,
          );
        }
        throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!data.ok) throw new Error(data.error?.message ?? `请求失败（HTTP ${response.status}）`);
      return data.value;
    }

    function timeText(iso) {
      if (!iso) return '—';
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
    }

    function bytesText(bytes) {
      if (!Number.isFinite(bytes)) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dshsync-field' },
        h('span', { className: 'dshsync-labelrow' }, h('span', { className: 'dshsync-label' }, props.label), props.info ? h(Info, { text: props.info }) : null),
        props.children,
        props.hint ? h('span', { className: 'dshsync-hint' }, props.hint) : null,
      );
    }

    function Info(props) {
      return h(
        'span',
        { className: 'dshsync-info', tabIndex: 0, 'aria-label': props.text, title: props.text },
        h('span', { 'aria-hidden': true }, 'ⓘ'),
        h('span', { className: 'dshsync-bubble', role: 'tooltip' }, props.text),
      );
    }

    function Text(props) {
      return h('input', {
        className: 'dshsync-input',
        type: props.type ?? 'text',
        value: props.value ?? '',
        placeholder: props.placeholder,
        readOnly: props.readOnly,
        spellCheck: false,
        autoComplete: 'off',
        disabled: props.disabled,
        onChange: props.readOnly ? undefined : (event) => props.onChange(event.target.value),
      });
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dshsync-btn${props.primary ? ' primary' : ''}${props.danger ? ' danger' : ''}${props.ghost ? ' ghost' : ''}`,
          disabled: props.disabled,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dshsync-kv' },
        h('span', { className: 'dshsync-k' }, props.label),
        h('span', { className: props.tone ? `dshsync-v ${props.tone}` : 'dshsync-v' }, props.value),
      );
    }

    /** Masked secret with an explicit "modify" affordance instead of an ambiguous placeholder. */
    function Secret(props) {
      if (props.isSet && !props.editing) {
        return h(
          'div',
          { className: 'dshsync-inlinerow' },
          h(Text, { value: DOTS, readOnly: true }),
          h(Button, { onClick: props.onEdit }, '修改'),
        );
      }
      return h(Text, {
        type: 'password',
        value: props.value,
        placeholder: props.placeholder ?? '请输入',
        onChange: props.onChange,
      });
    }

    /** 就地结果块：渲染在触发它的按钮正下方。 */
    function Feedback(props) {
      if (!props.feedback) return null;
      return h('div', { className: `dshsync-note ${props.feedback.tone}` }, props.feedback.text);
    }

    /** 长操作阶段指示（无百分比，只有阶段文案 + 转圈）。 */
    function Progress(props) {
      if (!props.stage) return null;
      return h(
        'div',
        { className: 'dshsync-progress', role: 'status' },
        h('span', { className: 'dshsync-spinner', 'aria-hidden': true }),
        h('span', null, props.stage),
      );
    }

    function SyncSettings() {
      const [status, setStatus] = useState(null);
      const [config, setConfig] = useState(null);
      const [tab, setTab] = useState('backup');
      const [kind, setKind] = useState('s3');
      const [form, setForm] = useState({});
      const [modules, setModules] = useState([]);
      const [extras, setExtras] = useState([]);
      const [editing, setEditing] = useState({ passphrase: false, s3Secret: false, webdavPassword: false });
      const [busy, setBusy] = useState('');
      const [stage, setStage] = useState('');
      const [globalNotice, setGlobalNotice] = useState(null);
      const [feedback, setFeedback] = useState({}); // per-action: { save: {tone,text}, push: {...} }
      const [plan, setPlan] = useState(null);
      const [snapshots, setSnapshots] = useState([]);
      const [selectedSnapshot, setSelectedSnapshot] = useState('');
      const [filePath, setFilePath] = useState('');
      const [planSource, setPlanSource] = useState('remote');
      const [naming, setNaming] = useState(null);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const [confirmRestore, setConfirmRestore] = useState(false);
      const [privacyAck, setPrivacyAck] = useState({}); // moduleId -> true
      const [showAllPlan, setShowAllPlan] = useState(false);
      const [dirty, setDirty] = useState(false);
      const formRef = useRef(form);
      formRef.current = form;

      const set = useCallback((key, value) => {
        setForm((current) => ({ ...current, [key]: value }));
        setDirty(true);
      }, []);

      const setNotice = useCallback((notice) => {
        setGlobalNotice(notice);
        if (notice) setTimeout(() => setGlobalNotice((current) => (current === notice ? null : current)), 5000);
      }, []);

      /** 恢复来源（快照选择、文件路径）一旦变化，已预览的清单即失效。 */
      const resetPlan = useCallback(() => {
        setPlan(null);
        setConfirmRestore(false);
        setShowAllPlan(false);
      }, []);

      const say = useCallback((action, tone, text) => setFeedback((current) => ({ ...current, [action]: { tone, text } })), []);

      const hydrate = useCallback((view) => {
        setConfig(view);
        setKind(view.profile.target.kind === 'none' ? 's3' : view.profile.target.kind);
        setForm({
          prefix: view.profile.target.prefix ?? 'dsh-sync',
          name: view.profile.target.name ?? '',
          endpoint: view.profile.target.s3?.endpoint ?? '',
          region: view.profile.target.s3?.region ?? 'auto',
          bucket: view.profile.target.s3?.bucket ?? '',
          accessKeyId: view.profile.target.s3?.accessKeyId ?? '',
          secretAccessKey: '',
          pathStyle: view.profile.target.s3?.pathStyle !== false,
          url: view.profile.target.webdav?.url ?? '',
          username: view.profile.target.webdav?.username ?? '',
          password: '',
          basePath: view.profile.target.webdav?.basePath ?? '',
          localPath: view.profile.target.local?.path ?? '',
          passphrase: '',
          scheduleEnabled: view.profile.schedule?.enabled === true,
          intervalMinutes: view.profile.schedule?.intervalMinutes ?? 30,
          include: { ...(view.profile.include ?? {}) },
        });
        setEditing({ passphrase: false, s3Secret: false, webdavPassword: false });
        setConfirmDelete(false);
        setFeedback({});
        setPrivacyAck({});
        setShowAllPlan(false);
        setDirty(false);
      }, []);

      const loadModules = useCallback(async (includeOverride) => {
        try {
          const value = await call('modules.preview', includeOverride ? { include: includeOverride } : {});
          setModules(value.modules ?? []);
          setExtras(value.extras ?? []);
          return value;
        } catch {
          return null; // 模块统计失败不阻塞页面
        }
      }, []);

      const loadSnapshots = useCallback(async () => {
        const list = await call('snapshots', { limit: 50 });
        const items = list.snapshots ?? [];
        setSnapshots(items);
        setSelectedSnapshot((current) => {
          if (current && items.some((item) => item.key === current)) return current;
          return list.latest?.snapshot ?? items[0]?.key ?? '';
        });
        return list;
      }, []);

      const refresh = useCallback(async () => {
        const value = await call('status');
        setStatus(value.status);
        hydrate(value.config);
        await loadModules(value.config.profile.include);
        await loadSnapshots().catch(() => {});
        return value;
      }, [hydrate, loadModules, loadSnapshots]);

      /** 只更新状态与快照列表，不重置表单——供测试/备份/恢复等不改变配置的操作使用，
       * 避免 hydrate 把未保存的表单草稿（含模块勾选）静默重置。 */
      const refreshStatus = useCallback(async () => {
        const value = await call('status');
        setStatus(value.status);
        await loadSnapshots().catch(() => {});
        return value;
      }, [loadSnapshots]);

      useEffect(() => {
        refresh().catch((error) => setNotice({ tone: 'err', text: `读取状态失败：${error.message}` }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const payload = useMemo(() => {
        const base = {
          passphrase: form.passphrase,
          schedule: { enabled: form.scheduleEnabled === true, intervalMinutes: Number(form.intervalMinutes) || 30 },
          include: { ...(form.include ?? {}) },
        };
        if (kind === 's3') {
          return {
            ...base,
            target: {
              kind,
              name: form.name || 's3',
              prefix: form.prefix,
              s3: {
                endpoint: form.endpoint,
                region: form.region || 'auto',
                bucket: form.bucket,
                accessKeyId: form.accessKeyId,
                secretAccessKey: form.secretAccessKey,
                pathStyle: form.pathStyle !== false,
              },
            },
          };
        }
        if (kind === 'webdav') {
          return {
            ...base,
            target: { kind, name: form.name || 'webdav', prefix: form.prefix, webdav: { url: form.url, username: form.username, password: form.password, basePath: form.basePath } },
          };
        }
        return { ...base, target: { kind, name: form.name || 'local', prefix: form.prefix, local: { path: form.localPath } } };
      }, [kind, form]);

      /** 显式保存：不再被测试/备份/预览隐式调用。 */
      const save = useCallback(async () => {
        if (editing.passphrase && form.passphrase.length > 0) {
          const errors = ruleErrors(form.passphrase);
          if (errors.length > 0) throw new Error(`口令不符合规则。${errors.join('；')}`);
        }
        const value = await call('config.save', payload);
        hydrate(value);
        await loadModules(value.profile.include);
        return value;
      }, [payload, hydrate, editing.passphrase, form.passphrase, loadModules]);

      const run = useCallback(
        (name, { stageText, task }) => {
          return () => {
            if (busy) return;
            setBusy(name);
            setStage(stageText ?? '');
            setFeedback((current) => ({ ...current, [name]: null }));
            setNotice(null);
            const promise = task();
            void promise
              .catch((error) => say(name, 'err', error.message))
              .finally(() => {
                setBusy('');
                setStage('');
              });
            return promise;
          };
        },
        [busy, say, setNotice],
      );

      const onSave = run('save', {
        stageText: '正在保存配置…',
        task: async () => {
          const value = await save();
          setDirty(false);
          say(
            'save',
            value.profile.problems.length === 0 ? 'ok' : 'warn',
            value.profile.problems.length === 0 ? `已保存到配置「${value.active}」。` : `已保存，但还缺少：${value.profile.problems.join('；')}`,
          );
        },
      });

      const onTest = run('test', {
        stageText: '正在连接存储目标…',
        task: async () => {
          // 显式保存模型：测试/备份只针对已保存的配置，表单草稿需先点「保存」或「保存并继续」。
          const result = await call('test');
          say('test', result.ok ? 'ok' : 'err', result.message);
          await refreshStatus().catch(() => {});
        },
      });

      const onPush = run('push', {
        stageText: '正在采集文件 → 打包加密 → 上传…',
        task: async () => {
          setStage('正在打包加密…');
          const result = await call('push');
          say(
            'push',
            'ok',
            result.skipped
              ? `「${result.profile}」内容没有变化，跳过上传。`
              : `备份完成：${result.stats.files} 个文件，${bytesText(result.bytes)}。${result.pruned > 0 ? `清理了 ${result.pruned} 个旧快照。` : ''}`,
          );
          await refreshStatus().catch(() => {});
        },
      });

      const onToggleModule = (module) => {
        const next = !(form.include?.[module.id] ?? module.defaultOn);
        if (module.sensitive && next && !privacyAck[module.id]) {
          setPrivacyAck((current) => ({ ...current, [module.id]: 'ask' }));
          return;
        }
        applyModuleToggle(module.id, next);
      };

      const applyModuleToggle = (moduleId, next) => {
        const include = { ...(formRef.current.include ?? {}), [moduleId]: next };
        setForm((current) => ({ ...current, include }));
        setDirty(true);
        // 不重新请求 modules.preview：统计口径是"本机各模块全量体积"，
        // 勾选开关只改"要不要备份"，数据本身不变。
      };

      const onPreview = run('preview', {
        stageText: '正在读取快照并比对本机…',
        task: async () => {
          const result = await call('pull', { dryRun: true, snapshot: selectedSnapshot || undefined });
          setPlanSource('remote');
          setPlan({ ...result, previewOf: { snapshot: selectedSnapshot } });
          setConfirmRestore(false);
          say(
            'preview',
            result.changes === 0 ? 'ok' : 'warn',
            result.changes === 0 ? '本机内容与这份快照一致，无需恢复。' : `预览完成：将改动 ${result.changes} 个文件，确认后才会写入。`,
          );
          await loadSnapshots().catch(() => {});
        },
      });

      const onPick = (pickKind) =>
        run(`pick-${pickKind}`, {
          task: async () => {
            const result = await call('pick.path', { kind: pickKind });
            if (result.path) {
              setFilePath(result.path);
              resetPlan();
              say(`pick-${pickKind}`, 'ok', `已选择：${result.path}`);
            } else if (result.message) {
              say(`pick-${pickKind}`, 'warn', result.message);
            }
          },
        })();

      const onPreviewFile = run('previewFile', {
        stageText: '正在读取快照并比对本机…',
        task: async () => {
          const result = await call('pull.file', { path: filePath, dryRun: true });
          setPlanSource('file');
          setPlan({ ...result, previewOf: { file: filePath } });
          setConfirmRestore(false);
          say(
            'previewFile',
            result.changes === 0 ? 'ok' : 'warn',
            result.changes === 0 ? '本机内容与这份快照一致，无需恢复。' : `预览完成：将改动 ${result.changes} 个文件，确认后才会写入。`,
          );
        },
      });

      const onApply = run('apply', {
        stageText: '正在备份本机现有文件 → 写入快照内容…',
        task: async () => {
          // 预览来源一致性校验：无论哪条路径改了快照选择或文件路径（包括快照列表
          // 刷新后的自动回落），都要重新预览，确认清单与实际落盘内容才可能一致。
          const previewMatches = planSource === 'file' ? plan?.previewOf?.file === filePath : plan?.previewOf?.snapshot === selectedSnapshot;
          if (!plan || !previewMatches) {
            resetPlan();
            say('apply', 'warn', '预览的来源已变化，请重新预览后再恢复。');
            return;
          }
          const result =
            planSource === 'file'
              ? await call('pull.file', { path: filePath, dryRun: false, confirm: true })
              : await call('pull', { dryRun: false, confirm: true, snapshot: selectedSnapshot || undefined });
          setPlan({ ...result, previewOf: plan.previewOf });
          setConfirmRestore(false);
          say(
            'apply',
            'ok',
            `已恢复 ${result.written} 个文件${result.backedUp ? `，覆盖前备份了 ${result.backedUp} 个文件` : ''}。${result.restartRequired ? ' 请完全退出 DSH 再打开，让配置生效。' : ''}`,
          );
          await refreshStatus().catch(() => {});
        },
      });

      const onRefreshSnapshots = run('snapshots', {
        task: async () => {
          const list = await loadSnapshots();
          say(
            'snapshots',
            list.snapshots.length > 0 ? 'ok' : 'warn',
            list.snapshots.length > 0
              ? `读到 ${list.snapshots.length} 个快照。`
              : '目标位置没有找到快照：检查目录/前缀，或先在本机备份一次。',
          );
        },
      });

      const switchProfile = (name, event) => {
        if (!name || name === config?.active) return;
        // 有未保存的修改时不静默切换：就地提示并回弹下拉框，草稿的去向由用户决定
        // （「保存并继续」或「放弃修改」后再次切换）。
        if (dirty) {
          if (event) event.target.value = config?.active ?? '';
          say('select', 'warn', '当前配置有未保存的修改。请先点「保存并继续」，或点「放弃修改」后再切换。');
          return;
        }
        run('select', {
          task: async () => {
            const value = await call('profile.select', { name });
            setStatus((current) => (current ? { ...current, profile: { ...current.profile, name: value.active, names: value.names } } : current));
            hydrate(value);
            setPlan(null);
            setNotice({ tone: 'ok', text: `已切换到配置「${value.active}」。` });
            await refresh().catch(() => {});
          },
        })();
      };

      const confirmNaming = () =>
        run('naming', {
          task: async () => {
            const name = (naming?.value ?? '').trim();
            if (!name) throw new Error('请先填写名称');
            if (naming.mode === 'create') {
              const value = await call('profile.create', { name });
              hydrate(value);
              setNotice({ tone: 'ok', text: `已新建配置「${value.active}」，填写目标与口令后保存。` });
            } else {
              const value = await call('profile.rename', { from: config.active, to: name });
              hydrate(value);
              setNotice({ tone: 'ok', text: `已重命名为「${value.active}」。` });
            }
            setNaming(null);
            await refresh().catch(() => {});
          },
        })();

      const removeProfile = () =>
        run('delete', {
          task: async () => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              say('delete', 'warn', `再点一次「删除」将移除配置「${config.active}」（不影响云端快照）。`);
              return;
            }
            const value = await call('profile.delete', { name: config.active });
            setConfirmDelete(false);
            hydrate(value);
            say('delete', 'ok', `已删除，当前配置为「${value.active}」。`);
            await refresh().catch(() => {});
          },
        })();

      /* ---------- 渲染 ---------- */

      const kindFields = () => {
        if (kind === 's3') {
          return h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'dshsync-row' },
              h(Field, { label: 'Endpoint', hint: 'R2 / B2 / MinIO 必填；AWS 留空用官方地址' }, h(Text, { value: form.endpoint, placeholder: 'https://<account>.r2.cloudflarestorage.com', onChange: (v) => set('endpoint', v) })),
              h(Field, { label: 'Region' }, h(Text, { value: form.region, placeholder: 'auto', onChange: (v) => set('region', v) })),
            ),
            h(Field, { label: 'Bucket' }, h(Text, { value: form.bucket, placeholder: 'dsh-config', onChange: (v) => set('bucket', v) })),
            h(
              'div',
              { className: 'dshsync-row' },
              h(Field, { label: 'Access Key ID' }, h(Text, { value: form.accessKeyId, onChange: (v) => set('accessKeyId', v) })),
              h(
                Field,
                { label: 'Secret Access Key' },
                h(Secret, {
                  isSet: config?.profile?.target?.s3?.secretSet === true,
                  editing: editing.s3Secret,
                  value: form.secretAccessKey,
                  placeholder: '请输入 Secret Access Key',
                  onEdit: () => setEditing((current) => ({ ...current, s3Secret: true })),
                  onChange: (v) => set('secretAccessKey', v),
                }),
              ),
            ),
            h('label', { className: 'dshsync-check' }, h('input', { type: 'checkbox', checked: form.pathStyle !== false, onChange: (event) => set('pathStyle', event.target.checked) }), 'Path-style 访问（R2 / MinIO / B2 建议开启）'),
          );
        }
        if (kind === 'webdav') {
          return h(
            React.Fragment,
            null,
            h(Field, { label: '服务地址', hint: '例如 https://dav.jianguoyun.com/dav/' }, h(Text, { value: form.url, placeholder: 'https://dav.jianguoyun.com/dav/', onChange: (v) => set('url', v) })),
            h(
              'div',
              { className: 'dshsync-row' },
              h(Field, { label: '用户名' }, h(Text, { value: form.username, onChange: (v) => set('username', v) })),
              h(
                Field,
                { label: '密码 / 应用密码' },
                h(Secret, {
                  isSet: config?.profile?.target?.webdav?.passwordSet === true,
                  editing: editing.webdavPassword,
                  value: form.password,
                  placeholder: '请输入应用密码',
                  onEdit: () => setEditing((current) => ({ ...current, webdavPassword: true })),
                  onChange: (v) => set('password', v),
                }),
              ),
            ),
            h(Field, { label: '基础路径（可选）' }, h(Text, { value: form.basePath, placeholder: '', onChange: (v) => set('basePath', v) })),
          );
        }
        return h(Field, { label: '同步目录', hint: '指向 OneDrive / iCloud / 坚果云同步盘或 NAS 挂载目录' }, h(Text, { value: form.localPath, placeholder: 'C:\\Users\\you\\OneDrive\\dsh-backup', onChange: (v) => set('localPath', v) }));
      };

      const statusDot = (() => {
        const problems = status?.problems ?? [];
        if (problems.length > 0) return { tone: 'err', text: '未配置完整' };
        if (status?.local?.changedSinceLastPush) return { tone: 'warn', text: '有变更待备份' };
        if (status?.lastPush) return { tone: 'ok', text: '已同步' };
        return { tone: 'warn', text: '尚未备份' };
      })();

      const passphraseSet = config?.profile?.passphraseSet === true;
      const passphraseErrors = form.passphrase ? ruleErrors(form.passphrase) : [];
      const problems = status?.problems ?? [];
      const statusProfileName = status?.profile?.name ?? config?.active ?? '';
      const planItems = plan ? (showAllPlan ? plan.sample ?? [] : (plan.sample ?? []).slice(0, 12)) : [];

      const statusHeader = h(
        'section',
        { className: 'dshsync-statusbar' },
        h('button', { type: 'button', className: 'dshsync-dotbtn', title: '查看状态详情', onClick: () => setTab('advanced') },
          h('span', { className: `dshsync-dot ${statusDot.tone}` }),
        ),
        h('span', { className: 'dshsync-statusmain' }, statusDot.text),
        h('span', { className: 'dshsync-statusmeta' },
          status?.target && status.target.kind !== 'none' ? `${KIND_LABEL[status.target.kind] ?? status.target.kind} · ` : '',
          status?.lastPush ? `上次备份 ${timeText(status.lastPush.at)} · ${bytesText(status.lastPush.bytes)}` : '还没有备份过',
          status?.remote?.latest ? ` · 云端 ${timeText(status.remote.latest.createdAt)}（${status.remote.latest.device}）` : '',
          status?.schedule?.enabled ? ` · 每 ${status.schedule.intervalMinutes} 分钟自动备份` : '',
        ),
        h('span', { className: 'dshsync-statusspacer' }),
        problems.length > 0 ? h('button', { type: 'button', className: 'dshsync-linkbtn', onClick: () => setTab('backup') }, `待完善：${problems.length} 项`) : null,
      );

      const tabBar = h(
        'nav',
        { className: 'dshsync-tabs', role: 'tablist' },
        [
          ['backup', '备份'],
          ['restore', '恢复 / 导入'],
          ['advanced', '高级'],
        ].map(([id, labelText]) =>
          h(
            'button',
            { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, className: tab === id ? 'on' : '', onClick: () => setTab(id) },
            labelText,
          ),
        ),
      );

      /** 备份页 */
      const backupTab = h(
        React.Fragment,
        null,
        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '备份内容'),
          h('p', { className: 'dshsync-hint' }, '选择哪些内容进入备份。体积与文件数是本机实时统计。'),
          h(
            'div',
            { className: 'dshsync-modules' },
            modules.map((module) => {
              const checked = module.required || (form.include?.[module.id] ?? module.defaultOn);
              const asking = module.sensitive && privacyAck[module.id] === 'ask';
              return h(
                'div',
                { key: module.id, className: `dshsync-module${module.sensitive ? ' sensitive' : ''}` },
                h(
                  'div',
                  { className: 'dshsync-modulerow' },
                  h('label', { className: 'dshsync-modulelabel' },
                    h('input', {
                      type: 'checkbox',
                      checked,
                      disabled: module.required || Boolean(busy),
                      onChange: () => onToggleModule(module),
                    }),
                    h('span', null, module.label),
                    module.sensitive ? h('span', { className: 'dshsync-badge' }, '含隐私') : null,
                    h(Info, { text: module.sensitive ? `${module.hint}。${PRIVACY_NOTICE}` : module.hint }),
                  ),
                  h('span', { className: 'dshsync-modulestats' },
                    module.present ? `${module.files} 个文件 · ${bytesText(module.bytes)}` : '本机没有此内容',
                  ),
                ),
                asking
                  ? h(
                      'div',
                      { className: 'dshsync-privacy' },
                      h('p', null, PRIVACY_NOTICE),
                      h(
                        'div',
                        { className: 'dshsync-actions dshsync-actions-tight' },
                        h(Button, { primary: true, onClick: () => { setPrivacyAck((current) => ({ ...current, [module.id]: true })); applyModuleToggle(module.id, true); } }, '我已了解，启用'),
                        h(Button, { onClick: () => setPrivacyAck((current) => ({ ...current, [module.id]: false })) }, '取消'),
                      ),
                    )
                  : null,
              );
            }),
            extras.map((extra) =>
              h(
                'div',
                { key: extra.id, className: 'dshsync-module' },
                h(
                  'div',
                  { className: 'dshsync-modulerow' },
                  h('span', { className: 'dshsync-modulelabel' }, h('span', null, extra.label), h(Info, { text: 'include.extraPaths 里配置的附加目录（本页暂不提供编辑，可用对话设置）' })),
                  h('span', { className: 'dshsync-modulestats' }, extra.present ? `${extra.files} 个文件 · ${bytesText(extra.bytes)}` : '不存在'),
                ),
              ),
            ),
          ),
          h(Row, { label: '加密方式', value: config?.security ?? '读取中…' }),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '存储目标'),
          h(
            'div',
            { className: 'dshsync-seg' },
            ['s3', 'webdav', 'local'].map((value) => h('button', { key: value, type: 'button', className: kind === value ? 'on' : '', onClick: () => { setKind(value); setDirty(true); } }, KIND_LABEL[value])),
          ),
          kindFields(),
          h(Field, { label: '对象前缀', hint: '同一个 bucket 里区分不同机器/账号' }, h(Text, { value: form.prefix, onChange: (v) => set('prefix', v) })),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '加密口令'),
          h(
            Field,
            {
              label: '口令',
              info: '规则：至少 8 位，必须同时包含大写字母、小写字母、数字和至少一个特殊符号（仅限 @ # $ * - _）；不得使用其它字符。恢复时必须输入同一个口令。',
              hint: passphraseSet ? '已保存。点「修改」才会替换；留空不变。' : '首次使用请设置口令，恢复时要用同一个。',
            },
            h(Secret, {
              isSet: passphraseSet,
              editing: editing.passphrase,
              value: form.passphrase,
              placeholder: '请输入口令',
              onEdit: () => setEditing((current) => ({ ...current, passphrase: true })),
              onChange: (v) => set('passphrase', v),
            }),
          ),
          editing.passphrase || form.passphrase
            ? h(
                React.Fragment,
                null,
                h(
                  'ul',
                  { className: 'dshsync-rules' },
                  RULES.map((rule) => {
                    const ok = rule.test(form.passphrase);
                    return h('li', { key: rule.text, className: ok ? 'ok' : 'bad' }, `${ok ? '✓' : '✗'} ${rule.text}`);
                  }),
                ),
                invalidChars(form.passphrase).length > 0
                  ? h('div', { className: 'dshsync-invalid' }, `不允许的字符：${invalidChars(form.passphrase).map(describeChar).join('、')}`)
                  : null,
              )
            : null,
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '自动备份'),
          h('label', { className: 'dshsync-check' }, h('input', { type: 'checkbox', checked: form.scheduleEnabled === true, onChange: (event) => set('scheduleEnabled', event.target.checked) }), '定时自动备份这个配置'),
          h('div', { className: 'dshsync-inline' }, h('span', { className: 'dshsync-label' }, '间隔'), h(Text, { value: String(form.intervalMinutes ?? 30), onChange: (v) => set('intervalMinutes', v) }), h('span', { className: 'dshsync-label' }, '分钟（内容无变化时不会上传）')),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '操作'),
          dirty
            ? h(
                'div',
                { className: 'dshsync-dirtybar' },
                h('span', null, '有未保存的修改。测试连接 / 立即备份只作用于已保存的配置。'),
                h('span', { className: 'dshsync-dirtyactions' },
                  h(Button, { primary: true, onClick: onSave, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存并继续'),
                  h(Button, { onClick: () => { refresh().catch(() => {}); }, disabled: Boolean(busy) }, '放弃修改'),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dshsync-actions' },
            h(Button, { onClick: onSave, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
            h(Button, { onClick: onTest, disabled: Boolean(busy) }, busy === 'test' ? '测试中…' : '测试连接'),
            h(Button, { primary: true, onClick: onPush, disabled: Boolean(busy) }, busy === 'push' ? '备份中…' : '立即备份'),
          ),
          h(Progress, { stage: busy === 'push' || busy === 'test' || busy === 'save' ? stage : '' }),
          h(Feedback, { feedback: feedback.save }),
          h(Feedback, { feedback: feedback.test }),
          h(Feedback, { feedback: feedback.push }),
        ),
      );

      /** 恢复页 */
      const restoreTab = h(
        React.Fragment,
        null,
        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '从云端恢复'),
          h(
            'p',
            { className: 'dshsync-hint' },
            kind === 'local' || status?.target?.kind === 'local'
              ? h(
                  React.Fragment,
                  null,
                  '本地模式：把另一台机器的 latest.json 和 snapshots 目录拷到目标目录后，这里会自动列出。目标目录：',
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshsync-linkbtn',
                      onClick: () => {
                        const target = `${status?.target?.path ?? ''}/${form.prefix || 'dsh-sync'}`;
                        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(target).then(() => say('copy', 'ok', `已复制：${target}`)).catch(() => say('copy', 'warn', `复制失败，请手动选择路径：${target}`));
                        else say('copy', 'warn', `当前环境不支持自动复制，请手动记录：${target}`);
                      },
                    },
                    '点此复制',
                  ),
                )
              : '只要目标与口令一致，就能读到这台机器以及其他设备推上去的快照。',
          ),
          h(Feedback, { feedback: feedback.copy }),
          snapshots.length === 0
            ? h('div', { className: 'dshsync-note warn' }, '还没有读到快照。先在「备份」页配置目标与口令并备份一次；或用下面的「从文件导入」。')
            : h(
                'label',
                { className: 'dshsync-field' },
                h('span', { className: 'dshsync-label' }, '选择要恢复的快照'),
                h(
                  'select',
                  {
                    className: 'dshsync-input dshsync-select',
                    value: selectedSnapshot,
                    onChange: (event) => {
                      setSelectedSnapshot(event.target.value);
                      resetPlan();
                    },
                  },
                  snapshots.map((snapshot) =>
                    h(
                      'option',
                      { key: snapshot.key, value: snapshot.key },
                      `${snapshot.label || snapshot.name}${snapshot.isLatest ? ' · 最新' : ''}（${snapshot.size}）`,
                    ),
                  ),
                ),
              ),
          h(
            'div',
            { className: 'dshsync-actions' },
            h(Button, { onClick: onRefreshSnapshots, disabled: Boolean(busy) }, busy === 'snapshots' ? '读取中…' : '刷新列表'),
            h(Button, { primary: true, onClick: onPreview, disabled: Boolean(busy) || !selectedSnapshot }, busy === 'preview' ? '读取中…' : '预览选中的快照'),
          ),
          h(Progress, { stage: busy === 'preview' ? stage : '' }),
          h(Feedback, { feedback: feedback.snapshots }),
          h(Feedback, { feedback: feedback.preview }),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '从文件导入'),
          h('p', { className: 'dshsync-hint' }, '手里是压缩包或零散文件？解压后直接指定 .dshsync 文件（或包含它的目录），不需要摆成目标目录结构。'),
          h(Text, {
            value: filePath,
            placeholder: '点下面选择文件/文件夹，或直接粘贴路径',
            onChange: (v) => {
              setFilePath(v);
              resetPlan();
            },
          }),
          h(
            'div',
            { className: 'dshsync-actions' },
            h(Button, { onClick: () => onPick('file'), disabled: Boolean(busy) }, busy === 'pick-file' ? '等待选择…' : '选择文件…'),
            h(Button, { onClick: () => onPick('folder'), disabled: Boolean(busy) }, busy === 'pick-folder' ? '等待选择…' : '选择文件夹…'),
            h(Button, { primary: true, onClick: onPreviewFile, disabled: Boolean(busy) || !filePath.trim() }, busy === 'previewFile' ? '读取中…' : '预览这个文件'),
          ),
          h(Progress, { stage: busy === 'previewFile' ? stage : '' }),
          h(Feedback, { feedback: feedback['pick-file'] }),
          h(Feedback, { feedback: feedback['pick-folder'] }),
          h(Feedback, { feedback: feedback.previewFile }),
        ),

        plan
          ? h(
              'section',
              { className: 'dshsync-card plan' },
              h('h3', null, plan.dryRun === false ? '恢复结果' : '恢复预览'),
              h(Row, { label: '快照时间', value: timeText(plan.createdAt) }),
              h(Row, { label: '来源设备', value: `${plan.device ?? '—'} · 配置「${plan.profileOfSnapshot ?? plan.profile ?? '—'}」` }),
              h(Row, { label: plan.dryRun === false ? '已写入文件' : '将改动文件', value: `${plan.changes ?? plan.written} 个` }),
              plan.bundles && plan.bundles.missing && plan.bundles.missing.length > 0
                ? h(Row, {
                    label: '插件安装',
                    value: plan.dryRun === false
                      ? `已自动安装 ${plan.bundles.missing.length} 个插件包（${plan.bundles.missing.map((bundle) => bundle.name).join('、')}）`
                      : `恢复后将自动安装 ${plan.bundles.missing.length} 个插件包（${plan.bundles.missing.map((bundle) => bundle.name).join('、')}）`,
                    tone: plan.dryRun === false ? 'ok' : undefined,
                  })
                : null,
              planItems.length > 0
                ? h(
                    'div',
                    null,
                    h('ul', { className: 'dshsync-list' }, planItems.map((item) => h('li', { key: `${item.path}-${item.action}` }, `${item.path}（${item.action}）`))),
                    (plan.sample ?? []).length > 12
                      ? h('button', { type: 'button', className: 'dshsync-linkbtn', onClick: () => setShowAllPlan((current) => !current) }, showAllPlan ? '收起' : `展开更多（至多 50 条）`)
                      : null,
                  )
              : null,
              plan.warnings && plan.warnings.length > 0 ? h('div', { className: 'dshsync-note warn' }, plan.warnings.join('；')) : null,
              plan.dryRun === false
                ? h('div', { className: 'dshsync-note ok' }, `恢复完成。${plan.restartRequired ? '已改到 profile，请完全退出 DSH 再打开。' : ''}${plan.backupDir ? ` 被覆盖文件的备份在 ${plan.backupDir}` : ''}`)
                : plan.dryRun && plan.changes > 0
                  ? h(
                      React.Fragment,
                      null,
                      confirmRestore
                        ? h('div', { className: 'dshsync-note warn' }, '恢复会覆盖上表列出的本机文件（覆盖前会自动备份到 backups/ 目录，不删除本机独有的文件）。')
                        : null,
                      h(
                        'div',
                        { className: 'dshsync-actions' },
                        h(Button, { primary: true, danger: confirmRestore, onClick: confirmRestore ? onApply : () => setConfirmRestore(true), disabled: Boolean(busy) }, busy === 'apply' ? '恢复中…' : confirmRestore ? '确认：覆盖这些文件' : '确认恢复到本机'),
                        h(Button, { onClick: () => { setPlan(null); setConfirmRestore(false); } }, '取消'),
                      ),
                      h(Progress, { stage: busy === 'apply' ? stage : '' }),
                    )
                  : null,
              h(Feedback, { feedback: feedback.apply }),
            )
          : null,
      );

      /** 高级页 */
      const advancedTab = h(
        React.Fragment,
        null,
        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '命名配置'),
          h('p', { className: 'dshsync-hint' }, '每个配置对应一个云端目标和一套口令。日常切换在页顶下拉框；这里管理名字与删除。'),
          h(
            'div',
            { className: 'dshsync-profilebar' },
            h(
              'select',
              { className: 'dshsync-input dshsync-select', value: config?.active ?? '', onChange: (event) => switchProfile(event.target.value, event) },
              (config?.names ?? []).map((name) => h('option', { key: name, value: name }, name)),
            ),
            h(Button, { onClick: () => setNaming({ mode: 'create', value: '' }), disabled: Boolean(busy) }, '新建'),
            h(Button, { onClick: () => setNaming({ mode: 'rename', value: config?.active ?? '' }), disabled: Boolean(busy) }, '重命名'),
            h(Button, { danger: confirmDelete, onClick: removeProfile, disabled: Boolean(busy) }, confirmDelete ? '确认删除' : '删除'),
            confirmDelete ? h(Button, { onClick: () => setConfirmDelete(false), disabled: Boolean(busy) }, '取消') : null,
          ),
          naming
            ? h(
                'div',
                { className: 'dshsync-naming' },
                h('input', {
                  className: 'dshsync-input',
                  value: naming.value,
                  autoFocus: true,
                  placeholder: naming.mode === 'create' ? '给这个同步配置起个名字，例如「家里的 R2」' : '新的名称',
                  onChange: (event) => setNaming({ ...naming, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') confirmNaming();
                    if (event.key === 'Escape') setNaming(null);
                  },
                }),
                h(Button, { primary: true, onClick: confirmNaming, disabled: Boolean(busy) }, '确定'),
                h(Button, { onClick: () => setNaming(null) }, '取消'),
              )
            : null,
          h(Feedback, { feedback: feedback.select }),
          h(Feedback, { feedback: feedback.naming }),
          h(Feedback, { feedback: feedback.delete }),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '状态详情'),
          h(Row, { label: '当前配置', value: `${statusProfileName}${status?.profile?.names?.length > 1 ? `（共 ${status.profile.names.length} 个）` : ''}` }),
          h(Row, {
            label: '备份目标',
            value: status?.target
              ? `${KIND_LABEL[status.target.kind] ?? status.target.kind}${status.target.bucket ? ` · ${status.target.bucket}` : ''}${status.target.path ? ` · ${status.target.path}` : ''}${status.target.url ? ` · ${status.target.url}` : ''}`
              : '读取中…',
          }),
          h(Row, {
            label: '本地变更',
            value: status?.local?.error ? status.local.error : status?.local?.changedSinceLastPush ? `有变更（${status.local.files} 个文件，${status.local.bytesText}）` : '已是最新',
            tone: status?.local?.changedSinceLastPush ? 'warn' : 'ok',
          }),
          h(Row, { label: '最近备份', value: status?.lastPush ? `${timeText(status.lastPush.at)} · ${bytesText(status.lastPush.bytes)}` : '尚未备份' }),
          h(Row, {
            label: '云端最新',
            value: status?.remote?.error ? `无法读取：${status.remote.error}` : status?.remote?.latest ? `${timeText(status.remote.latest.createdAt)} · ${status.remote.latest.device} · ${status.remote.latest.files} 个文件` : '云端还没有快照',
            tone: status?.remote?.error ? 'err' : undefined,
          }),
          h(Row, { label: '定时同步', value: status?.schedule?.enabled ? `每 ${status.schedule.intervalMinutes} 分钟` : '已关闭' }),
          problems.length > 0 ? h(Row, { label: '配置待完善', value: problems.join('；'), tone: 'warn' }) : null,
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '数据与日志'),
          h(Row, { label: 'DSH 目录', value: status?.paths?.home ?? '—' }),
          h(Row, { label: '配置档案', value: status?.paths?.profile ?? '—' }),
          h(Row, { label: '插件数据', value: status?.paths?.data ?? '~/.dsh/dsh-sync' }),
          h('p', { className: 'dshsync-foot' }, '配置以密文保存在 ~/.dsh/dsh-sync/config.json；日志在 ~/.dsh/dsh-sync/sync.log；恢复前被覆盖的文件备份在 ~/.dsh/dsh-sync/backups/。'),
        ),
      );

      return h(
        'div',
        { className: 'dshsync-root' },
        h('style', null, CSS),
        h('h2', null, 'DSH 同步'),
        h('p', { className: 'dshsync-sub' }, '把插件、设置、技能等个人配置加密备份到云端，换电脑后一键恢复。'),
        globalNotice ? h('div', { className: `dshsync-note ${globalNotice.tone} toast` }, globalNotice.text) : null,
        statusHeader,
        tabBar,
        tab === 'backup' ? backupTab : tab === 'restore' ? restoreTab : advancedTab,
      );
    }

    const CSS = `
.dshsync-root { padding: 4px 24px 48px; max-width: 780px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dshsync-root h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
.dshsync-sub { margin: 0 0 14px; color: var(--dsw-alias-label-secondary); }
.dshsync-statusbar { display: flex; align-items: center; gap: 8px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; flex-wrap: wrap; }
.dshsync-dotbtn { background: none; border: 0; padding: 2px; cursor: pointer; display: inline-flex; }
.dshsync-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; display: block; }
.dshsync-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dshsync-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.dshsync-dot.err { background: var(--dsw-alias-state-error-primary); }
.dshsync-statusmain { font-weight: 600; }
.dshsync-statusmeta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshsync-statusspacer { flex: 1; }
.dshsync-tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshsync-tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 8px 14px; font-size: 13px; font-family: inherit; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshsync-tabs button.on { color: var(--dsw-alias-label-primary); font-weight: 600; border-bottom-color: var(--dsw-alias-brand-primary); }
.dshsync-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
.dshsync-card h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.dshsync-card.plan { border-color: var(--dsw-alias-border-l2); }
.dshsync-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; position: relative; }
.dshsync-labelrow { display: flex; align-items: center; gap: 6px; }
.dshsync-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshsync-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; opacity: .8; margin: 0 0 10px; }
.dshsync-input { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; outline: none; width: 100%; box-sizing: border-box; }
.dshsync-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dshsync-input[readonly] { color: var(--dsw-alias-label-secondary); letter-spacing: 2px; }
.dshsync-row { display: flex; gap: 12px; }
.dshsync-row > * { flex: 1; min-width: 0; }
.dshsync-inlinerow { display: flex; gap: 8px; align-items: center; }
.dshsync-inlinerow .dshsync-input { flex: 1; }
.dshsync-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; margin-bottom: 14px; }
.dshsync-seg button { background: transparent; border: 0; padding: 7px 14px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; font-family: inherit; }
.dshsync-seg button.on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dshsync-check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 4px 0 10px; }
.dshsync-inline { display: flex; align-items: center; gap: 8px; }
.dshsync-inline .dshsync-input { width: 84px; }
.dshsync-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 2px 0 10px; }
.dshsync-actions-tight { margin: 0 0 6px; }
.dshsync-btn { border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 7px 14px; font-size: 12px; font-family: inherit; cursor: pointer; white-space: nowrap; }
.dshsync-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dshsync-btn.primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 600; }
.dshsync-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); border-color: transparent; }
.dshsync-btn.danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshsync-btn.ghost { border-color: transparent; background: transparent; }
.dshsync-btn:disabled { opacity: .55; cursor: default; }
.dshsync-linkbtn { background: none; border: 0; color: var(--dsw-alias-brand-primary); cursor: pointer; font-size: 12px; font-family: inherit; padding: 4px 0; }
.dshsync-note { background: var(--dsw-alias-bg-layer-2); border-left: 3px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; font-size: 12px; white-space: pre-wrap; }
.dshsync-note.ok { border-left-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dshsync-note.warn { border-left-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dshsync-note.err { border-left-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshsync-note.toast { position: sticky; top: 8px; z-index: 30; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
.dshsync-progress { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 10px; }
.dshsync-spinner { width: 12px; height: 12px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: dshsync-spin .8s linear infinite; }
@keyframes dshsync-spin { to { transform: rotate(360deg); } }
.dshsync-dirtybar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: var(--dsw-alias-bg-layer-2); border-left: 3px solid var(--dsw-alias-state-warn-primary); border-radius: 6px; padding: 8px 12px; font-size: 12px; margin-bottom: 10px; color: var(--dsw-alias-label-secondary); }
.dshsync-dirtyactions { display: flex; gap: 8px; }
.dshsync-kv { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.dshsync-kv:last-child { border-bottom: 0; }
.dshsync-k { color: var(--dsw-alias-label-secondary); flex: none; }
.dshsync-v { text-align: right; word-break: break-all; }
.dshsync-v.ok { color: var(--dsw-alias-state-success-primary); }
.dshsync-v.warn { color: var(--dsw-alias-state-warn-primary); }
.dshsync-v.err { color: var(--dsw-alias-state-error-primary); }
.dshsync-list { margin: 8px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 12px; max-height: 260px; overflow: auto; }
.dshsync-foot { color: var(--dsw-alias-label-secondary); font-size: 11px; margin: 4px 0 0; }
.dshsync-profilebar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.dshsync-select { flex: 1; cursor: pointer; }
.dshsync-naming { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.dshsync-naming .dshsync-input { flex: 1; }
.dshsync-info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: var(--dsw-alias-label-secondary); cursor: help; font-size: 12px; outline: none; }
.dshsync-info:hover, .dshsync-info:focus-visible { color: var(--dsw-alias-brand-primary); }
.dshsync-bubble { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 40; width: 320px; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 6px 20px rgba(0,0,0,.18); font-size: 12px; line-height: 1.6; opacity: 0; visibility: hidden; transform: translateY(4px); transition: opacity .12s ease, transform .12s ease; pointer-events: none; font-weight: 400; }
.dshsync-info:hover .dshsync-bubble, .dshsync-info:focus-visible .dshsync-bubble { opacity: 1; visibility: visible; transform: translateY(0); }
.dshsync-rules { list-style: none; margin: 2px 0 4px; padding: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 4px 14px; }
.dshsync-rules li.ok { color: var(--dsw-alias-state-success-primary); }
.dshsync-rules li.bad { color: var(--dsw-alias-state-error-primary); }
.dshsync-invalid { color: var(--dsw-alias-state-error-primary); font-size: 11px; margin: 2px 0 4px; }
.dshsync-modules { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.dshsync-module { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 12px; }
.dshsync-module.sensitive { border-color: var(--dsw-alias-state-warn-primary); }
.dshsync-modulerow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dshsync-modulelabel { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dshsync-modulestats { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: none; }
.dshsync-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.dshsync-privacy { margin-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 8px; }
.dshsync-privacy p { margin: 0 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-sync', order: 25, label: '同步' }, SyncSettings),
        );
      },
    };
  },
});
