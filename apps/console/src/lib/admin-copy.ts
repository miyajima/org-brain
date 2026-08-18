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
  }
}[locale]);

const ROLE_LABELS: Record<AdminLocale, Record<string, string>> = {
  en: { reader: "Reader", contributor: "Contributor", tenant_admin: "Tenant administrator", auditor: "Auditor" },
  ja: { reader: "閲覧者", contributor: "編集者", tenant_admin: "テナント管理者", auditor: "監査担当者" },
  zh: { reader: "查看者", contributor: "贡献者", tenant_admin: "租户管理员", auditor: "审计员" }
};

const USER_STATUS_LABELS: Record<AdminLocale, Record<string, string>> = {
  en: { invited: "Invited", active: "Active", suspended: "Suspended", deprovisioned: "Deprovisioned" },
  ja: { invited: "招待中", active: "利用中", suspended: "一時停止", deprovisioned: "利用解除" },
  zh: { invited: "已邀请", active: "使用中", suspended: "已暂停", deprovisioned: "已停用" }
};

export const adminRoleLabel = (value: string, locale: AdminLocale) => ROLE_LABELS[locale][value] ?? value;
export const adminUserStatusLabel = (value: string, locale: AdminLocale) => USER_STATUS_LABELS[locale][value] ?? value;
