/**
 * Client half: the "同步" page inside Settings.
 *
 * Loaded as a plain browser module (no build step). It talks to the Host through
 * `/dsh-sync/api`, which the Host plugin registers on the same web server.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

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
          className: `dshsync-btn${props.primary ? ' primary' : ''}${props.danger ? ' danger' : ''}`,
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

    function SyncSettings() {
      const [status, setStatus] = useState(null);
      const [config, setConfig] = useState(null);
      const [kind, setKind] = useState('s3');
      const [form, setForm] = useState({});
      const [editing, setEditing] = useState({ passphrase: false, s3Secret: false, webdavPassword: false });
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [plan, setPlan] = useState(null);
      const [snapshots, setSnapshots] = useState([]);
      const [selectedSnapshot, setSelectedSnapshot] = useState('');
      const [filePath, setFilePath] = useState('');
      const [planSource, setPlanSource] = useState('remote');
      const [naming, setNaming] = useState(null);
      const [confirmDelete, setConfirmDelete] = useState(false);

      const set = useCallback((key, value) => setForm((current) => ({ ...current, [key]: value })), []);

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
        });
        setEditing({ passphrase: false, s3Secret: false, webdavPassword: false });
        setConfirmDelete(false);
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
        await loadSnapshots().catch(() => {});
        return value;
      }, [hydrate, loadSnapshots]);

      useEffect(() => {
        refresh().catch((error) => setNotice({ tone: 'err', text: `读取状态失败：${error.message}` }));
      }, [refresh]);

      const payload = useMemo(() => {
        const base = {
          passphrase: form.passphrase,
          schedule: { enabled: form.scheduleEnabled === true, intervalMinutes: Number(form.intervalMinutes) || 30 },
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

      const save = useCallback(async () => {
        if (editing.passphrase && form.passphrase.length > 0) {
          const errors = ruleErrors(form.passphrase);
          if (errors.length > 0) throw new Error(`口令不符合规则。${errors.join('；')}`);
        }
        const value = await call('config.save', payload);
        hydrate(value);
        return value;
      }, [payload, hydrate, editing.passphrase, form.passphrase]);

      const run = useCallback(
        async (name, task) => {
          if (busy) return;
          setBusy(name);
          setNotice(null);
          try {
            await task();
          } catch (error) {
            setNotice({ tone: 'err', text: error.message });
          } finally {
            setBusy('');
          }
        },
        [busy],
      );

      const onSave = () => run('save', async () => {
        const value = await save();
        setNotice({
          tone: value.profile.problems.length === 0 ? 'ok' : 'warn',
          text: value.profile.problems.length === 0 ? `已保存到配置「${value.active}」。` : `已保存，但还缺少：${value.profile.problems.join('；')}`,
        });
      });

      const onTest = () => run('test', async () => {
        await save();
        const result = await call('test');
        setNotice({ tone: result.ok ? 'ok' : 'err', text: result.message });
        await refresh().catch(() => {});
      });

      const onPush = () => run('push', async () => {
        await save();
        const result = await call('push');
        setNotice({
          tone: 'ok',
          text: result.skipped
            ? `「${result.profile}」内容没有变化，跳过上传。`
            : `配置「${result.profile}」备份完成：${result.stats.files} 个文件，${bytesText(result.bytes)}。`,
        });
        await refresh().catch(() => {});
      });

      const onPreview = () => run('preview', async () => {
        await save();
        setPlanSource('remote');
        const result = await call('pull', { dryRun: true, snapshot: selectedSnapshot || undefined });
        setPlan(result);
        setNotice(
          result.changes === 0
            ? { tone: 'ok', text: '本机内容与这份快照一致，无需恢复。' }
            : { tone: 'warn', text: `预览完成：将改动 ${result.changes} 个文件。确认后才会写入。` },
        );
        await loadSnapshots().catch(() => {});
      });

      const onPick = (kind) => run(`pick-${kind}`, async () => {
        const result = await call('pick.path', { kind });
        if (result.path) {
          setFilePath(result.path);
          setPlan(null);
          setNotice({ tone: 'ok', text: `已选择：${result.path}` });
        } else if (result.message) {
          setNotice({ tone: 'warn', text: result.message });
        }
      });

      const onPreviewFile = () => run('previewFile', async () => {
        await save();
        setPlanSource('file');
        const result = await call('pull.file', { path: filePath, dryRun: true });
        setPlan(result);
        setNotice(
          result.changes === 0
            ? { tone: 'ok', text: '本机内容与这份快照一致，无需恢复。' }
            : { tone: 'warn', text: `预览完成：将改动 ${result.changes} 个文件。确认后才会写入。` },
        );
      });

      const onApply = () => run('apply', async () => {
        const result =
          planSource === 'file'
            ? await call('pull.file', { path: filePath, dryRun: false, confirm: true })
            : await call('pull', { dryRun: false, confirm: true, snapshot: selectedSnapshot || undefined });
        setPlan(result);
        setNotice({
          tone: 'ok',
          text: `已恢复 ${result.written} 个文件${result.backedUp ? `，覆盖前备份了 ${result.backedUp} 个文件` : ''}。${result.restartRequired ? ' 请重启 DSH 让配置生效。' : ''}`,
        });
        await refresh().catch(() => {});
      });

      const onRefreshSnapshots = () => run('snapshots', async () => {
        const list = await loadSnapshots();
        setNotice({
          tone: list.snapshots.length > 0 ? 'ok' : 'warn',
          text:
            list.snapshots.length > 0
              ? `读到 ${list.snapshots.length} 个快照，已选中${list.latest?.snapshot === selectedSnapshot ? '最新' : '当前'}那份。`
              : '目标位置没有找到快照：检查目录/前缀，或先在本机备份一次。',
        });
      });

      const switchProfile = (name) => run('select', async () => {
        const value = await call('profile.select', { name });
        setStatus((current) => (current ? { ...current, profile: { ...current.profile, name: value.active, names: value.names } } : current));
        hydrate(value);
        setPlan(null);
        setNotice({ tone: 'ok', text: `已切换到配置「${value.active}」。` });
        await refresh().catch(() => {});
      });

      const confirmNaming = () => run('naming', async () => {
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
      });

      const removeProfile = () => run('delete', async () => {
        if (!confirmDelete) {
          setConfirmDelete(true);
          setNotice({ tone: 'warn', text: `再点一次「删除」将移除配置「${config.active}」（不影响云端快照）。` });
          return;
        }
        const value = await call('profile.delete', { name: config.active });
        setConfirmDelete(false);
        hydrate(value);
        setNotice({ tone: 'ok', text: `已删除，当前配置为「${value.active}」。` });
        await refresh().catch(() => {});
      });

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

      const passphraseSet = config?.profile?.passphraseSet === true;
      const passphraseErrors = form.passphrase ? ruleErrors(form.passphrase) : [];
      const problems = status?.problems ?? [];
      const statusProfileName = status?.profile?.name ?? config?.active ?? '';

      return h(
        'div',
        { className: 'dshsync-root' },
        h('style', null, CSS),
        h('h2', null, 'DSH 同步'),
        h('p', { className: 'dshsync-sub' }, '每个同步配置对应一个云端目标和一套口令，可保存多份；换电脑时装好插件、选中同名配置、点恢复即可。'),

        notice ? h('div', { className: `dshsync-note ${notice.tone}` }, notice.text) : null,

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '同步配置'),
          h(
            'div',
            { className: 'dshsync-profilebar' },
            h(
              'select',
              { className: 'dshsync-input dshsync-select', value: config?.active ?? '', onChange: (event) => switchProfile(event.target.value) },
              (config?.names ?? []).map((name) => h('option', { key: name, value: name }, name)),
            ),
            h(Button, { onClick: () => setNaming({ mode: 'create', value: '' }), disabled: Boolean(busy) }, '新建'),
            h(Button, { onClick: () => setNaming({ mode: 'rename', value: config?.active ?? '' }), disabled: Boolean(busy) }, '重命名'),
            h(Button, { danger: confirmDelete, onClick: removeProfile, disabled: Boolean(busy) }, confirmDelete ? '确认删除' : '删除'),
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
          h(Row, { label: '加密方式', value: config?.security ?? '读取中…' }),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '1. 备份到哪里'),
          h(
            'div',
            { className: 'dshsync-seg' },
            ['s3', 'webdav', 'local'].map((value) => h('button', { key: value, type: 'button', className: kind === value ? 'on' : '', onClick: () => setKind(value) }, KIND_LABEL[value])),
          ),
          kindFields(),
          h(Field, { label: '对象前缀', hint: '同一个 bucket 里区分不同机器/账号' }, h(Text, { value: form.prefix, onChange: (v) => set('prefix', v) })),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '2. 加密口令'),
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
          h('h3', null, '3. 自动同步'),
          h('label', { className: 'dshsync-check' }, h('input', { type: 'checkbox', checked: form.scheduleEnabled === true, onChange: (event) => set('scheduleEnabled', event.target.checked) }), '定时自动备份这个配置'),
          h('div', { className: 'dshsync-inline' }, h('span', { className: 'dshsync-label' }, '间隔'), h(Text, { value: String(form.intervalMinutes ?? 30), onChange: (v) => set('intervalMinutes', v) }), h('span', { className: 'dshsync-label' }, '分钟（内容无变化时不会上传）')),
        ),

        h(
          'div',
          { className: 'dshsync-actions' },
          h(Button, { onClick: onSave, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
          h(Button, { onClick: onTest, disabled: Boolean(busy) }, busy === 'test' ? '测试中…' : '测试连接'),
          h(Button, { primary: true, onClick: onPush, disabled: Boolean(busy) }, busy === 'push' ? '备份中…' : '立即备份'),
        ),

        h(
          'section',
          { className: 'dshsync-card' },
          h('h3', null, '状态'),
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
          h('h3', null, '恢复 / 导入'),
          h(
            'p',
            { className: 'dshsync-hint' },
            kind === 'local'
              ? `本地模式：把另一台机器的 latest.json 和 snapshots 目录拷到「${status?.target?.path ?? '目标目录'}${
                  status?.target?.path ? (status.target.path.includes('\\') ? '\\' : '/') : ''
                }${form.prefix || 'dsh-sync'}」下，点“刷新列表”；也可以不走目录，直接在下面指定快照文件。`
              : '云端模式：只要目标与口令一致，就能读到这台机器以及其他机器推上去的快照。',
          ),
          snapshots.length === 0
            ? h('div', { className: 'dshsync-note warn' }, '还没有读到快照。确认目标与口令后点“刷新列表”；本地模式请先拷贝 latest.json 与 snapshots 目录。')
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
                      setPlan(null);
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
            { className: 'dshsync-field' },
            h('span', { className: 'dshsync-label' }, '或者：直接指定备份文件 / 解压后的目录'),
            h(
              'div',
              { className: 'dshsync-inlinerow' },
              h(Text, {
                value: filePath,
                placeholder: '点下面的“选择文件…”或“选择文件夹…”，也可以直接粘贴路径',
                onChange: setFilePath,
              }),
            ),
            h(
              'div',
              { className: 'dshsync-actions dshsync-actions-tight' },
              h(Button, { onClick: () => onPick('file'), disabled: Boolean(busy) }, busy === 'pick-file' ? '等待选择…' : '选择文件…'),
              h(Button, { onClick: () => onPick('folder'), disabled: Boolean(busy) }, busy === 'pick-folder' ? '等待选择…' : '选择文件夹…'),
              h(Button, { onClick: onPreviewFile, disabled: Boolean(busy) || !filePath.trim() }, busy === 'previewFile' ? '读取中…' : '预览这个文件'),
            ),
            h('span', { className: 'dshsync-hint' }, '支持单个 .dshsync 文件，或包含快照的目录（例如解压出来的 dsh-sync 文件夹、它的 snapshots 子目录）。'),
          ),
          h(
            'div',
            { className: 'dshsync-actions' },
            h(Button, { onClick: onRefreshSnapshots, disabled: Boolean(busy) }, busy === 'snapshots' ? '读取中…' : '刷新列表'),
            h(Button, { primary: true, onClick: onPreview, disabled: Boolean(busy) || !selectedSnapshot }, busy === 'preview' ? '读取中…' : '预览选中的快照'),
          ),
          plan
            ? h(
                React.Fragment,
                null,
                h(Row, { label: '快照时间', value: timeText(plan.createdAt) }),
                h(Row, { label: '来源设备', value: `${plan.device ?? '—'} · 配置「${plan.profileOfSnapshot ?? plan.profile ?? '—'}」` }),
                h(Row, { label: '改动文件', value: `${plan.changes ?? plan.written} 个` }),
                plan.sample && plan.sample.length > 0
                  ? h('ul', { className: 'dshsync-list' }, plan.sample.slice(0, 30).map((item) => h('li', { key: `${item.path}-${item.action}` }, `${item.path}（${item.action}）`)))
                  : null,
                plan.warnings && plan.warnings.length > 0 ? h('div', { className: 'dshsync-note warn' }, plan.warnings.join('；')) : null,
                plan.dryRun && plan.changes === 0 ? h('div', { className: 'dshsync-note ok' }, '没有需要改动的文件。') : null,
                plan.dryRun && plan.changes > 0
                  ? h(
                      'div',
                      { className: 'dshsync-actions' },
                      h(Button, { primary: true, onClick: onApply, disabled: Boolean(busy) }, busy === 'apply' ? '恢复中…' : '确认恢复到本机'),
                      h(Button, { onClick: () => setPlan(null) }, '取消'),
                    )
                  : null,
                plan.dryRun === false ? h('div', { className: 'dshsync-note ok' }, '恢复完成。改到了 profile 的话，请完全退出 DSH 再打开。') : null,
              )
            : null,
        ),

        h('p', { className: 'dshsync-foot' }, '配置以密文保存在 ~/.dsh/dsh-sync/config.json；恢复会先把被覆盖的文件备份到 backups/，不会删除本机独有的文件。'),
      );
    }

    const CSS = `
.dshsync-root { padding: 4px 24px 48px; max-width: 780px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dshsync-root h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
.dshsync-sub { margin: 0 0 18px; color: var(--dsw-alias-label-secondary); }
.dshsync-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
.dshsync-card h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.dshsync-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; position: relative; }
.dshsync-labelrow { display: flex; align-items: center; gap: 6px; }
.dshsync-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshsync-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; opacity: .8; }
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
.dshsync-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 2px 0 18px; }
.dshsync-actions-tight { margin: 0 0 6px; }
.dshsync-btn { border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 7px 14px; font-size: 12px; font-family: inherit; cursor: pointer; white-space: nowrap; }
.dshsync-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dshsync-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; font-weight: 600; }
.dshsync-btn.danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshsync-btn:disabled { opacity: .55; cursor: default; }
.dshsync-note { background: var(--dsw-alias-bg-layer-2); border-left: 3px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; font-size: 12px; white-space: pre-wrap; }
.dshsync-note.ok { border-left-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dshsync-note.warn { border-left-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dshsync-note.err { border-left-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshsync-kv { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.dshsync-kv:last-child { border-bottom: 0; }
.dshsync-k { color: var(--dsw-alias-label-secondary); flex: none; }
.dshsync-v { text-align: right; word-break: break-all; }
.dshsync-v.ok { color: var(--dsw-alias-state-success-primary); }
.dshsync-v.warn { color: var(--dsw-alias-state-warn-primary); }
.dshsync-v.err { color: var(--dsw-alias-state-error-primary); }
.dshsync-list { margin: 8px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 12px; max-height: 220px; overflow: auto; }
.dshsync-details { margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
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
