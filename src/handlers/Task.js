const { TaskStatus, Role } = require("@prisma/client");
const prisma = require("../lib/prisma");
const Response = require("./Response");
const PushNotificationService = require("./PushNotificationService");
const { emitBroadcast } = require("../socket");

const pushNotificationService = new PushNotificationService();

const STATUS_TO_API = {
  [TaskStatus.TODO]: "todo",
  [TaskStatus.IN_PROGRESS]: "in_progress",
  [TaskStatus.DELAY]: "delay",
  [TaskStatus.COMPLETE]: "complete",
  [TaskStatus.DISCARDED]: "discarded",
};

const API_TO_STATUS = {
  todo: TaskStatus.TODO,
  in_progress: TaskStatus.IN_PROGRESS,
  delay: TaskStatus.DELAY,
  complete: TaskStatus.COMPLETE,
  discarded: TaskStatus.DISCARDED,
};

const toTaskStatus = (value) => {
  if (value == null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, "_");
  if (API_TO_STATUS[normalized]) return API_TO_STATUS[normalized];
  const upper = normalized.toUpperCase();
  return TaskStatus[upper] || undefined;
};

const toDateOrNull = (value) => {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toFloatOrNull = (value) => {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const toIntOrNull = (value) => {
  if (value == null || value === "") return null;
  const parsed = parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const taskInclude = {
  createdByUser: { select: { id: true, name: true } },
  updatedByUser: { select: { id: true, name: true } },
};

const serializeTask = (task, siteNameMap = {}) => {
  if (!task) return task;
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    assigned_to: task.assigned_to,
    contractor: task.contractor,
    penalty: task.penalty,
    due_date: task.due_date,
    site_id: task.site_id,
    site_name:
      task.site_id != null
        ? siteNameMap[task.site_id] || null
        : null,
    status: STATUS_TO_API[task.status] || String(task.status || "").toLowerCase(),
    created_by: task.created_by,
    created_by_name: task.createdByUser?.name || null,
    created_at: task.created_at,
    updated_by: task.updated_by,
    updated_by_name: task.updatedByUser?.name || null,
    updated_at: task.updated_at,
  };
};

const getSiteNameMap = async (tasks) => {
  const ids = [
    ...new Set(
      (Array.isArray(tasks) ? tasks : [tasks])
        .map((task) => task?.site_id)
        .filter((id) => id != null)
        .map(Number)
    ),
  ];
  if (!ids.length) return {};
  const sites = await prisma.site.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return Object.fromEntries(sites.map((site) => [site.id, site.name]));
};

const STATUS_LABELS = {
  todo: "To Do",
  in_progress: "In Progress",
  delay: "Delay",
  complete: "Complete",
  discarded: "Discarded",
};

const getTaskStatusLabel = (status) => {
  const apiStatus = STATUS_TO_API[status] || String(status || "").toLowerCase();
  return STATUS_LABELS[apiStatus] || apiStatus || "Unknown";
};

const formatLogValue = (key, value) => {
  if (value == null || value === "") return "—";
  if (key === "status") return getTaskStatusLabel(value);
  if (key === "due_date") {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toISOString().slice(0, 10);
  }
  if (key === "penalty") return String(value);
  return String(value);
};

const valuesEqual = (key, a, b) => {
  if (key === "due_date") {
    const aTime =
      a == null || a === ""
        ? null
        : new Date(a).getTime();
    const bTime =
      b == null || b === ""
        ? null
        : new Date(b).getTime();
    if (aTime == null && bTime == null) return true;
    if (aTime == null || bTime == null) return false;
    return aTime === bTime;
  }
  if (key === "penalty" || key === "site_id") {
    const aNum = a == null || a === "" ? null : Number(a);
    const bNum = b == null || b === "" ? null : Number(b);
    return aNum === bNum;
  }
  const aStr = a == null ? "" : String(a).trim();
  const bStr = b == null ? "" : String(b).trim();
  return aStr === bStr;
};

const FIELD_LABELS = {
  name: "name",
  description: "description",
  assigned_to: "assignee",
  contractor: "contractor",
  penalty: "penalty",
  due_date: "due date",
  site_id: "site",
  status: "status",
};

const buildUpdateChanges = (existing, data) => {
  const keys = [
    "name",
    "description",
    "assigned_to",
    "contractor",
    "penalty",
    "due_date",
    "site_id",
    "status",
  ];
  const changes = [];
  for (const key of keys) {
    if (data[key] === undefined) continue;
    if (valuesEqual(key, existing[key], data[key])) continue;
    changes.push({
      field: key,
      from: existing[key] ?? null,
      to: data[key] ?? null,
    });
  }
  return changes;
};

const createTaskLog = async ({
  taskId,
  action,
  actorId,
  actorName,
  message,
  fromValue = null,
  toValue = null,
  meta = null,
}) => {
  try {
    await prisma.taskLog.create({
      data: {
        task_id: taskId ?? null,
        action,
        actor_id: actorId ?? null,
        actor_name: actorName || null,
        message: message || null,
        from_value: fromValue != null ? String(fromValue) : null,
        to_value: toValue != null ? String(toValue) : null,
        meta: meta ?? undefined,
      },
    });
  } catch (logError) {
    console.error(
      "[Task][Log] failed to write task log:",
      logError?.message || logError
    );
  }
};

const serializeTaskLog = (log) => {
  if (!log) return log;
  return {
    id: log.id,
    task_id: log.task_id,
    action: log.action,
    actor_id: log.actor_id,
    actor_name: log.actor_name || log.actor?.name || null,
    message: log.message,
    from_value: log.from_value,
    to_value: log.to_value,
    meta: log.meta,
    created_at: log.created_at,
  };
};

const getTaskNotificationRecipientIds = async (assignedTo) => {
  const adminUsers = await prisma.user.findMany({
    where: {
      role: { in: [Role.ADMIN, Role.SUPER_ADMIN] },
    },
    select: { id: true },
  });

  const recipientIds = adminUsers.map((user) => user.id);
  const assignedName = String(assignedTo || "").trim();
  if (assignedName) {
    const assignedSupervisor = await prisma.user.findFirst({
      where: {
        role: Role.SUPERVISOR,
        name: { equals: assignedName, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (assignedSupervisor?.id) {
      recipientIds.push(assignedSupervisor.id);
    }
  }

  return recipientIds;
};

const isAdminOrSuperAdmin = (role) => {
  const normalized = String(role || "").toUpperCase();
  return normalized === "ADMIN" || normalized === "SUPER_ADMIN";
};

const isSupervisor = (role) =>
  String(role || "").toUpperCase() === "SUPERVISOR";

const canAccessTasks = (role) =>
  isAdminOrSuperAdmin(role) || isSupervisor(role);

class Task extends Response {
  denyUnlessTaskAccess = (req, res) => {
    if (canAccessTasks(req.user?.role)) return false;
    this.sendResponse(req, res, {
      status: 403,
      message: "Only admin, super admin, and supervisor can access tasks",
    });
    return true;
  };

  denyUnlessAdmin = (req, res) => {
    if (isAdminOrSuperAdmin(req.user?.role)) return false;
    this.sendResponse(req, res, {
      status: 403,
      message: "Only admin and super admin can modify or delete tasks",
    });
    return true;
  };

  markOverdueAsDelay = async () => {
    await prisma.task.updateMany({
      where: {
        due_date: { lt: startOfToday() },
        status: {
          notIn: [TaskStatus.COMPLETE, TaskStatus.DISCARDED, TaskStatus.DELAY],
        },
      },
      data: { status: TaskStatus.DELAY },
    });
  };

  create = async (req, res) => {
    try {
      if (this.denyUnlessTaskAccess(req, res)) return;

      const {
        name,
        description,
        assigned_to,
        contractor,
        penalty,
        due_date,
        site_id,
        status,
      } = req.body;

      if (!name || !String(name).trim()) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "name is required",
        });
      }

      const statusEnum = toTaskStatus(status) || TaskStatus.TODO;
      const userId = req.user?.id ? Number(req.user.id) : null;
      const creatorIsSupervisor = isSupervisor(req.user?.role);
      const resolvedAssignedTo = creatorIsSupervisor
        ? String(req.user?.name || "").trim() || null
        : assigned_to != null
          ? String(assigned_to)
          : null;

      const task = await prisma.task.create({
        data: {
          name: String(name).trim(),
          description: description != null ? String(description) : null,
          assigned_to: resolvedAssignedTo,
          contractor: contractor != null ? String(contractor) : null,
          penalty: toIntOrNull(penalty),
          due_date: toDateOrNull(due_date),
          site_id:
            site_id != null && site_id !== "" ? Number(site_id) : null,
          status: statusEnum,
          created_by: userId,
          updated_by: userId,
        },
        include: taskInclude,
      });

      const siteNameMap = await getSiteNameMap(task);
      const serialized = serializeTask(task, siteNameMap);
      const creatorName = req.user?.name || "Admin";

      await createTaskLog({
        taskId: task.id,
        action: "created",
        actorId: userId,
        actorName: creatorName,
        message: `${creatorName} created this task`,
        toValue: STATUS_TO_API[task.status] || task.status,
        meta: {
          status: STATUS_TO_API[task.status] || task.status,
          assigned_to: task.assigned_to,
          site_id: task.site_id,
        },
      });

      try {
        const recipientIds = await getTaskNotificationRecipientIds(
          resolvedAssignedTo
        );

        const siteLabel = serialized.site_name
          ? ` for site ${serialized.site_name}`
          : "";
        const assignedName = String(resolvedAssignedTo || "").trim();

        const dispatchResult = await pushNotificationService.dispatchNotifications({
          event: "TASK_CREATED",
          senderId: userId,
          // Never notify the user who created the task.
          includeSender: false,
          recipientIds,
          title: "New Task Created",
          body: `${creatorName} created task "${serialized.name}"${siteLabel}${
            assignedName ? ` and assigned it to ${assignedName}` : ""
          }.`,
          type: "Task",
          data: {
            taskId: serialized.id,
            siteId: serialized.site_id,
            status: serialized.status,
            assigned_to: serialized.assigned_to,
            action: "created",
            link: "/task-management",
          },
        });

        console.log("[Task][Notification] create dispatch:", {
          taskId: serialized.id,
          recipientCount: dispatchResult?.totalRecipients ?? 0,
          createdCount: dispatchResult?.createdCount ?? 0,
          recipientIds: [...new Set(recipientIds)],
        });
      } catch (notifyError) {
        console.error(
          "[Task][Notification] failed to send create notification:",
          notifyError?.message || notifyError
        );
      }

      try {
        emitBroadcast("task:updated", {
          action: "created",
          task: serialized,
        });
      } catch (socketError) {
        console.error(
          "[Task][Socket] failed to broadcast create:",
          socketError?.message || socketError
        );
      }

      return this.sendResponse(req, res, {
        status: 201,
        message: "Task created",
        data: serialized,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Task creation failed",
        error: error.message,
      });
    }
  };

  getAll = async (req, res) => {
    try {
      if (this.denyUnlessTaskAccess(req, res)) return;

      await this.markOverdueAsDelay();

      const where = {};
      if (isSupervisor(req.user?.role)) {
        const supervisorName = String(req.user?.name || "").trim();
        where.assigned_to = {
          equals: supervisorName,
          mode: "insensitive",
        };
      }
      if (req.query.site_id) {
        where.site_id = Number(req.query.site_id);
      }
      if (req.query.status) {
        const statusEnum = toTaskStatus(req.query.status);
        if (statusEnum) where.status = statusEnum;
      }

      const tasks = await prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: [{ due_date: "asc" }, { created_at: "desc" }],
      });

      const siteNameMap = await getSiteNameMap(tasks);

      return this.sendResponse(req, res, {
        status: 200,
        message: "Tasks fetched",
        data: tasks.map((task) => serializeTask(task, siteNameMap)),
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch tasks",
        error: error.message,
      });
    }
  };

  getById = async (req, res) => {
    try {
      if (this.denyUnlessTaskAccess(req, res)) return;

      await this.markOverdueAsDelay();

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid task id",
        });
      }

      const task = await prisma.task.findUnique({
        where: { id },
        include: taskInclude,
      });

      if (!task) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Task not found",
        });
      }

      if (isSupervisor(req.user?.role)) {
        const supervisorName = String(req.user?.name || "")
          .trim()
          .toLowerCase();
        const assignedName = String(task.assigned_to || "")
          .trim()
          .toLowerCase();
        if (!supervisorName || assignedName !== supervisorName) {
          return this.sendResponse(req, res, {
            status: 403,
            message: "You can only view your own tasks",
          });
        }
      }

      const siteNameMap = await getSiteNameMap(task);

      return this.sendResponse(req, res, {
        status: 200,
        message: "Task fetched",
        data: serializeTask(task, siteNameMap),
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch task",
        error: error.message,
      });
    }
  };

  update = async (req, res) => {
    try {
      if (this.denyUnlessAdmin(req, res)) return;

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid task id",
        });
      }

      const existing = await prisma.task.findUnique({ where: { id } });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Task not found",
        });
      }

      const data = {
        updated_by: req.user?.id ? Number(req.user.id) : null,
      };

      if (req.body.name !== undefined) {
        if (!String(req.body.name).trim()) {
          return this.sendResponse(req, res, {
            status: 400,
            message: "name is required",
          });
        }
        data.name = String(req.body.name).trim();
      }
      if (req.body.description !== undefined) {
        data.description =
          req.body.description == null ? null : String(req.body.description);
      }
      if (req.body.assigned_to !== undefined) {
        data.assigned_to =
          req.body.assigned_to == null ? null : String(req.body.assigned_to);
      }
      if (req.body.contractor !== undefined) {
        data.contractor =
          req.body.contractor == null ? null : String(req.body.contractor);
      }
      if (req.body.penalty !== undefined) {
        data.penalty = toIntOrNull(req.body.penalty);
      }
      if (req.body.due_date !== undefined) {
        data.due_date = toDateOrNull(req.body.due_date);
      }
      if (req.body.site_id !== undefined) {
        data.site_id =
          req.body.site_id === null || req.body.site_id === ""
            ? null
            : Number(req.body.site_id);
      }
      if (req.body.status !== undefined) {
        const statusEnum = toTaskStatus(req.body.status);
        if (!statusEnum) {
          return this.sendResponse(req, res, {
            status: 400,
            message:
              "status must be one of: todo, in_progress, delay, complete, discarded",
          });
        }
        data.status = statusEnum;
      }

      const changes = buildUpdateChanges(existing, data);
      const task = await prisma.task.update({
        where: { id },
        data,
        include: taskInclude,
      });

      const siteNameMap = await getSiteNameMap(task);
      const serialized = serializeTask(task, siteNameMap);
      const actorId = req.user?.id ? Number(req.user.id) : null;
      const actorName = req.user?.name || "Admin";

      if (changes.length) {
        const changeSummary = changes
          .map((change) => {
            const label = FIELD_LABELS[change.field] || change.field;
            return `${label}: ${formatLogValue(change.field, change.from)} → ${formatLogValue(change.field, change.to)}`;
          })
          .join("; ");

        await createTaskLog({
          taskId: task.id,
          action: "updated",
          actorId,
          actorName,
          message: `${actorName} updated ${changeSummary}`,
          meta: {
            changes: changes.map((change) => ({
              field: change.field,
              from:
                change.field === "status"
                  ? STATUS_TO_API[change.from] || change.from
                  : change.from,
              to:
                change.field === "status"
                  ? STATUS_TO_API[change.to] || change.to
                  : change.to,
            })),
          },
        });
      }

      try {
        emitBroadcast("task:updated", {
          action: "updated",
          task: serialized,
        });
      } catch (socketError) {
        console.error(
          "[Task][Socket] failed to broadcast update:",
          socketError?.message || socketError
        );
      }

      return this.sendResponse(req, res, {
        status: 200,
        message: "Task updated",
        data: serialized,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Task update failed",
        error: error.message,
      });
    }
  };

  updateStatus = async (req, res) => {
    try {
      if (this.denyUnlessTaskAccess(req, res)) return;

      const id = Number(req.params.id);
      const statusEnum = toTaskStatus(req.body.status);

      if (!Number.isFinite(id) || id <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid task id",
        });
      }

      if (!statusEnum) {
        return this.sendResponse(req, res, {
          status: 400,
          message:
            "status must be one of: todo, in_progress, delay, complete, discarded",
        });
      }

      const existing = await prisma.task.findUnique({ where: { id } });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Task not found",
        });
      }

      if (isSupervisor(req.user?.role)) {
        const supervisorName = String(req.user?.name || "")
          .trim()
          .toLowerCase();
        const assignedName = String(existing.assigned_to || "")
          .trim()
          .toLowerCase();
        if (!supervisorName || assignedName !== supervisorName) {
          return this.sendResponse(req, res, {
            status: 403,
            message: "You can only move your own tasks",
          });
        }
      }

      const previousStatus = existing.status;
      const userId = req.user?.id ? Number(req.user.id) : null;
      const moverName = req.user?.name || "User";
      const fromLabel = getTaskStatusLabel(previousStatus);
      const toLabel = getTaskStatusLabel(statusEnum);

      const task = await prisma.task.update({
        where: { id },
        data: {
          status: statusEnum,
          updated_by: userId,
        },
        include: taskInclude,
      });

      const siteNameMap = await getSiteNameMap(task);
      const serialized = serializeTask(task, siteNameMap);

      if (previousStatus !== statusEnum) {
        await createTaskLog({
          taskId: task.id,
          action: "status_changed",
          actorId: userId,
          actorName: moverName,
          message: `${moverName} moved ${fromLabel} → ${toLabel}`,
          fromValue: STATUS_TO_API[previousStatus] || previousStatus,
          toValue: STATUS_TO_API[statusEnum] || statusEnum,
        });

        try {
          const recipientIds = await getTaskNotificationRecipientIds(
            task.assigned_to
          );
          const siteLabel = serialized.site_name
            ? ` (${serialized.site_name})`
            : "";

          const dispatchResult =
            await pushNotificationService.dispatchNotifications({
              event: "TASK_STATUS_UPDATED",
              senderId: userId,
              includeSender: false,
              recipientIds,
              title: "Task Status Updated",
              body: `${moverName} moved "${serialized.name}"${siteLabel} from ${fromLabel} to ${toLabel}.`,
              type: "Task",
              data: {
                taskId: serialized.id,
                siteId: serialized.site_id,
                status: serialized.status,
                previousStatus: STATUS_TO_API[previousStatus] || previousStatus,
                assigned_to: serialized.assigned_to,
                action: "status_updated",
                link: "/task-management",
              },
            });

          console.log("[Task][Notification] status dispatch:", {
            taskId: serialized.id,
            from: fromLabel,
            to: toLabel,
            recipientCount: dispatchResult?.totalRecipients ?? 0,
            createdCount: dispatchResult?.createdCount ?? 0,
          });
        } catch (notifyError) {
          console.error(
            "[Task][Notification] failed to send status notification:",
            notifyError?.message || notifyError
          );
        }
      }

      try {
        emitBroadcast("task:updated", {
          action: "status_updated",
          task: serialized,
          previousStatus: STATUS_TO_API[previousStatus] || previousStatus,
        });
      } catch (socketError) {
        console.error(
          "[Task][Socket] failed to broadcast status update:",
          socketError?.message || socketError
        );
      }

      return this.sendResponse(req, res, {
        status: 200,
        message: "Task status updated",
        data: serialized,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to update status",
        error: error.message,
      });
    }
  };

  delete = async (req, res) => {
    try {
      if (this.denyUnlessAdmin(req, res)) return;

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid task id",
        });
      }

      const existing = await prisma.task.findUnique({ where: { id } });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Task not found",
        });
      }

      const actorId = req.user?.id ? Number(req.user.id) : null;
      const actorName = req.user?.name || "Admin";

      await createTaskLog({
        taskId: id,
        action: "deleted",
        actorId,
        actorName,
        message: `${actorName} deleted task "${existing.name}"`,
        fromValue: STATUS_TO_API[existing.status] || existing.status,
        meta: {
          name: existing.name,
          status: STATUS_TO_API[existing.status] || existing.status,
          assigned_to: existing.assigned_to,
          site_id: existing.site_id,
          due_date: existing.due_date,
        },
      });

      await prisma.task.delete({ where: { id } });

      try {
        emitBroadcast("task:updated", {
          action: "deleted",
          taskId: id,
        });
      } catch (socketError) {
        console.error(
          "[Task][Socket] failed to broadcast delete:",
          socketError?.message || socketError
        );
      }

      return this.sendResponse(req, res, {
        status: 200,
        message: "Task deleted",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Task deletion failed",
        error: error.message,
      });
    }
  };

  getLogs = async (req, res) => {
    try {
      if (this.denyUnlessTaskAccess(req, res)) return;

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid task id",
        });
      }

      const task = await prisma.task.findUnique({
        where: { id },
        select: { id: true, assigned_to: true },
      });

      if (!task) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Task not found",
        });
      }

      if (isSupervisor(req.user?.role)) {
        const supervisorName = String(req.user?.name || "")
          .trim()
          .toLowerCase();
        const assignedName = String(task.assigned_to || "")
          .trim()
          .toLowerCase();
        if (!supervisorName || assignedName !== supervisorName) {
          return this.sendResponse(req, res, {
            status: 403,
            message: "You can only view logs for your own tasks",
          });
        }
      }

      const logs = await prisma.taskLog.findMany({
        where: { task_id: id },
        include: {
          actor: { select: { id: true, name: true } },
        },
        orderBy: { created_at: "desc" },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Task logs fetched",
        data: logs.map(serializeTaskLog),
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch task logs",
        error: error.message,
      });
    }
  };
}

module.exports = Task;
