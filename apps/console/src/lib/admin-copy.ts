export type AdminLocale = "en" | "ja" | "zh";

export function adminLocale(value: unknown): AdminLocale {
  return value === "ja" || value === "zh" ? value : "en";
}

export const userAdminCopy = (locale: AdminLocale) => ({
  en: {
    title: "Users",
    description: "Invite people and manage access to this tenant.",
    inviteTitle: "Invite a user",
    inviteDescription: "Choose the minimum role needed. Access can be changed later.",
    existingTitle: "Existing users",
    existingDescription: "Review identity, access status, and role assignments.",
    noUsers: "No users have been added to this tenant yet.",
    email: "Email",
    displayName: "Display name",
    fullName: "Full name",
    role: "Role",
    status: "Status",
    invite: "Invite",
    save: "Save changes",
    invited: "Invitation created.",
    updated: "User updated.",
    saveError: "The user could not be saved. Review the fields and try again.",
    managedName: "Full name is managed by the identity provider.",
    userMeta: "Identity details"
    , search: "Search users"
    , searchPlaceholder: "Name or email"
    , filter: "Filter"
    , clear: "Clear"
    , allStatuses: "All statuses"
    , allRoles: "All roles"
    , edit: "Edit user"
    , technical: "Technical details"
    , previous: "Previous"
    , next: "Next"
    , resultCount: "users"
    , inviteImpact: "Invites this person to the tenant with the selected role."
    , inviteRecovery: "Status and role can be changed after the invitation."
    , updateImpact: "Status and effective access change immediately."
    , updateRecovery: "Status and role can be changed again from this page."
  },
  ja: {
    title: "ユーザー",
    description: "このテナントへユーザーを招待し、アクセス権を管理します。",
    inviteTitle: "ユーザーを招待",
    inviteDescription: "必要最小限のロールを選択してください。アクセス権は後から変更できます。",
    existingTitle: "既存ユーザー",
    existingDescription: "本人情報、利用状態、割り当てロールを確認します。",
    noUsers: "このテナントにはまだユーザーが登録されていません。",
    email: "メールアドレス",
    displayName: "表示名",
    fullName: "氏名",
    role: "ロール",
    status: "状態",
    invite: "招待する",
    save: "変更を保存",
    invited: "招待を作成しました。",
    updated: "ユーザーを更新しました。",
    saveError: "ユーザーを保存できませんでした。入力内容を確認して再試行してください。",
    managedName: "氏名はIDプロバイダーによって管理されています。",
    userMeta: "ID情報"
    , search: "ユーザーを検索"
    , searchPlaceholder: "氏名またはメールアドレス"
    , filter: "絞り込む"
    , clear: "解除"
    , allStatuses: "すべての状態"
    , allRoles: "すべてのロール"
    , edit: "ユーザーを編集"
    , technical: "技術情報"
    , previous: "前へ"
    , next: "次へ"
    , resultCount: "人"
    , inviteImpact: "このテナントへ選択したロールで招待します。"
    , inviteRecovery: "招待後に利用状態やロールを変更できます。"
    , updateImpact: "利用状態と実効権限が直ちに変わります。"
    , updateRecovery: "同じ画面から状態とロールを再変更できます。"
  },
  zh: {
    title: "用户",
    description: "邀请用户加入此租户并管理其访问权限。",
    inviteTitle: "邀请用户",
    inviteDescription: "请选择所需的最低权限角色，之后仍可更改。",
    existingTitle: "现有用户",
    existingDescription: "查看身份、访问状态和角色分配。",
    noUsers: "此租户尚未添加用户。",
    email: "电子邮箱",
    displayName: "显示名称",
    fullName: "姓名",
    role: "角色",
    status: "状态",
    invite: "发送邀请",
    save: "保存更改",
    invited: "邀请已创建。",
    updated: "用户已更新。",
    saveError: "无法保存用户，请检查输入后重试。",
    managedName: "姓名由身份提供商管理。",
    userMeta: "身份详情"
    , search: "搜索用户"
    , searchPlaceholder: "姓名或电子邮箱"
    , filter: "筛选"
    , clear: "清除"
    , allStatuses: "所有状态"
    , allRoles: "所有角色"
    , edit: "编辑用户"
    , technical: "技术信息"
    , previous: "上一页"
    , next: "下一页"
    , resultCount: "位用户"
    , inviteImpact: "将以所选角色邀请此用户加入该租户。"
    , inviteRecovery: "邀请后仍可更改使用状态和角色。"
    , updateImpact: "使用状态和实际访问权限将立即变更。"
    , updateRecovery: "可在此页面再次更改状态和角色。"
  }
}[locale]);

const ROLE_LABELS: Record<AdminLocale, Record<string, string>> = {
  en: { tenant_admin: "Organization administrator", project_owner: "Project owner", contributor: "Editing member", reader: "Viewing member", auditor: "Auditor", service_agent: "AI / automation" },
  ja: { tenant_admin: "組織管理者", project_owner: "プロジェクト責任者", contributor: "編集メンバー", reader: "閲覧メンバー", auditor: "監査担当", service_agent: "AI・自動処理" },
  zh: { tenant_admin: "组织管理员", project_owner: "项目负责人", contributor: "编辑成员", reader: "查看成员", auditor: "审计员", service_agent: "AI / 自动处理" }
};

const USER_STATUS_LABELS: Record<AdminLocale, Record<string, string>> = {
  en: { invited: "Invited", active: "Active", suspended: "Suspended", deprovisioned: "Deprovisioned" },
  ja: { invited: "招待中", active: "利用中", suspended: "一時停止", deprovisioned: "利用解除" },
  zh: { invited: "已邀请", active: "使用中", suspended: "已暂停", deprovisioned: "已停用" }
};

export const adminRoleLabel = (value: string, locale: AdminLocale) => ROLE_LABELS[locale][value] ?? value;
export const adminUserStatusLabel = (value: string, locale: AdminLocale) => USER_STATUS_LABELS[locale][value] ?? value;

export const groupAdminCopy = (locale: AdminLocale) => ({
  en: { title: "Group details", fallback: "Group", back: "Back to groups", user: "User", groupRole: "Group role", add: "Add or update", principal: "Identity", role: "Role", status: "Status", source: "Source", remove: "Remove", archive: "Archive group", archived: "Group archived", updated: "Membership updated", updateError: "The group could not be updated", loadError: "The group could not be loaded", technical: "Technical details", previewLoading: "Checking access impact…", previewError: "Impact preview is unavailable. Removal is disabled.", ownerRemovalHelp: "You cannot remove yourself while you are an owner. Add another owner, then ask that owner to remove you.", ownerRemovalAction: "Add another owner", addImpact: (group: string) => `Adds this identity to ${group} with the selected group role.`, addRecovery: "Membership can be removed from this page.", removeRecovery: "The user can be added again if needed.", archiveImpact: "Removes the group from active lists and stops membership-based access.", archiveRecovery: "The current API cannot restore it from this screen; recreation is required.", removeAria: (name: string) => `Remove ${name} from group`, impact: (lost: number, retained: number) => `This person will lose access to ${lost} items and retain access to ${retained} items.`, roles: { member: "Member", admin: "Group administrator", owner: "Owner" } },
  ja: { title: "グループ詳細", fallback: "グループ", back: "グループ一覧へ戻る", user: "ユーザー", groupRole: "グループ内の役割", add: "追加・更新", principal: "ID", role: "役割", status: "状態", source: "登録元", remove: "解除", archive: "グループをアーカイブ", archived: "グループをアーカイブしました", updated: "所属を更新しました", updateError: "グループを更新できませんでした", loadError: "グループを読み込めませんでした", technical: "技術情報", previewLoading: "アクセスへの影響を確認しています…", previewError: "影響を確認できないため、解除できません。", ownerRemovalHelp: "所有者のまま自分自身を解除することはできません。別の所有者を追加し、その所有者へ解除を依頼してください。", ownerRemovalAction: "別の所有者を追加", addImpact: (group: string) => `${group}の共有範囲へ、選択した役割で追加します。`, addRecovery: "所属はこの画面から削除できます。", removeRecovery: "必要な場合は同じユーザーを再追加できます。", archiveImpact: "グループを通常一覧から外し、所属による共有アクセスを停止します。", archiveRecovery: "現在のAPIでは画面から復元できません。再作成が必要です。", removeAria: (name: string) => `${name}をグループから解除`, impact: (lost: number, retained: number) => `${lost}件へのアクセスを失い、${retained}件へのアクセスは維持されます。`, roles: { member: "メンバー", admin: "グループ管理者", owner: "所有者" } },
  zh: { title: "群组详情", fallback: "群组", back: "返回群组列表", user: "用户", groupRole: "群组角色", add: "添加或更新", principal: "身份", role: "角色", status: "状态", source: "来源", remove: "移除", archive: "归档群组", archived: "群组已归档", updated: "成员关系已更新", updateError: "无法更新群组", loadError: "无法加载群组", technical: "技术信息", previewLoading: "正在检查访问影响…", previewError: "无法获取影响预览，已禁用移除操作。", ownerRemovalHelp: "作为所有者时不能移除自己。请先添加另一位所有者，再请其移除您。", ownerRemovalAction: "添加另一位所有者", addImpact: (group: string) => `将以所选群组角色把此身份添加到${group}的共享范围。`, addRecovery: "可在此页面移除该成员关系。", removeRecovery: "如有需要，可以重新添加同一用户。", archiveImpact: "从活动列表中移除该群组，并停止基于成员关系的共享访问。", archiveRecovery: "当前API无法在此页面恢复该群组，需要重新创建。", removeAria: (name: string) => `从群组移除${name}`, impact: (lost: number, retained: number) => `将失去 ${lost} 项访问权限，并保留 ${retained} 项访问权限。`, roles: { member: "成员", admin: "群组管理员", owner: "所有者" } }
}[locale]);
