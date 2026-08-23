import {
  registerCollaborationRoutes as registerSharedCollaborationRoutes,
  type CollaborationPort
} from "@org-brain/server-core";
import {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage
} from "./agent-message-service";
import {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  type ApiContextEnv
} from "./auth";
import {
  addGroupMember,
  archiveGroup,
  createGroup,
  getGroup,
  listGroups,
  removeGroupMember,
  updateGroup
} from "./group-service";
import { getMyIdentity, updateUserProfile } from "./identity-service";
import { getResourceShare, updateResourceShare } from "./share-service";
import { createTask, getTask, getTaskEvents, listTasks } from "./task-service";
import type { Hono } from "hono";

const collaborationPort = {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  addGroupMember,
  archiveGroup,
  createGroup,
  getGroup,
  listGroups,
  removeGroupMember,
  updateGroup,
  getMyIdentity,
  updateUserProfile,
  getResourceShare,
  updateResourceShare,
  createTask,
  getTask,
  getTaskEvents,
  listTasks
} satisfies CollaborationPort<ApiContextEnv>;

export function registerCollaborationRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedCollaborationRoutes(app, collaborationPort);
}
