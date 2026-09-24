-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'QA', 'ACCOUNT', 'DIRECTOR', 'SUPERVISOR', 'PURCHASER', 'SR_ENGINEER');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CONFLICT', 'COMPLETED');

-- CreateEnum
CREATE TYPE "StageName" AS ENUM ('QA', 'ACCOUNT', 'PURCHASER', 'SUPERVISOR', 'RECEIVING');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'MEDIA', 'AUDIO', 'FILE');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "cnic" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "purchaserAllProducts" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "alreadyAssigned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isEdit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "plot_size" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" INTEGER,
    "currentStage" TEXT NOT NULL DEFAULT '',
    "locationUrl" TEXT,
    "coveredArea" TEXT,
    "marketingPersonName" TEXT,
    "marketingPersonPhone" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "productId" INTEGER,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMaterialUpdate" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "rows" JSONB NOT NULL DEFAULT '[]',
    "createdBy" INTEGER,
    "createdByName" TEXT,
    "updatedBy" INTEGER,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyMaterialUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyIssueUpdate" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "rows" JSONB NOT NULL DEFAULT '[]',
    "createdBy" INTEGER,
    "createdByName" TEXT,
    "updatedBy" INTEGER,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyIssueUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySiteProgressUpdate" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "stage" TEXT NOT NULL DEFAULT '',
    "workSummary" TEXT NOT NULL DEFAULT '',
    "createdBy" INTEGER,
    "createdByName" TEXT,
    "updatedBy" INTEGER,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySiteProgressUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractorData" (
    "id" SERIAL NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" INTEGER NOT NULL,

    CONSTRAINT "ContractorData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementData" (
    "id" SERIAL NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" INTEGER NOT NULL,

    CONSTRAINT "AgreementData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" SERIAL NOT NULL,
    "siteRequestId" INTEGER NOT NULL DEFAULT 0,
    "qty" DOUBLE PRECISION NOT NULL,
    "stageWiseQty" JSONB,
    "steelItes" JSONB,
    "sanitaryImage" JSONB,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "releasedQty" DOUBLE PRECISION,
    "receivedQty" DOUBLE PRECISION DEFAULT 0,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "siteId" INTEGER NOT NULL,
    "stageName" "StageName",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "productId" INTEGER NOT NULL,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestImage" (
    "id" SERIAL NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/webp',
    "size" INTEGER NOT NULL DEFAULT 0,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestStage" (
    "id" SERIAL NOT NULL,
    "requestId" INTEGER NOT NULL,
    "stageName" "StageName" NOT NULL,
    "status" TEXT NOT NULL,
    "comment" TEXT,
    "userId" INTEGER NOT NULL,
    "stageImageId" INTEGER,
    "receivedAt" TIMESTAMP(3),
    "forwardAt" TIMESTAMP(3),

    CONSTRAINT "RequestStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialTotal" (
    "id" SERIAL NOT NULL,
    "data" JSONB NOT NULL,
    "file_name" TEXT NOT NULL DEFAULT 'File',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" INTEGER NOT NULL,

    CONSTRAINT "MaterialTotal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageMaterial" (
    "id" SERIAL NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "siteId" INTEGER NOT NULL,

    CONSTRAINT "StageMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMember" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "ChatMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "content" TEXT,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "mediaUrl" TEXT,
    "audioDuration" INTEGER,
    "audioData" BYTEA,
    "fileData" BYTEA,
    "fileName" TEXT,
    "mimeType" TEXT,
    "senderId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatGroup" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER,
    "lastMessage" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ChatGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "unit" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageItem" (
    "id" SERIAL NOT NULL,
    "stageId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProduct" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,

    CONSTRAINT "UserProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraMaterial" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "purchase_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rate" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtraMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteSupervisor" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "SiteSupervisor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePurchaser" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "allProducts" BOOLEAN NOT NULL DEFAULT false,
    "productIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "SitePurchaser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteSeniorEngineer" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "SiteSeniorEngineer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "DailyMaterialUpdate_siteId_date_idx" ON "DailyMaterialUpdate"("siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMaterialUpdate_siteId_date_key" ON "DailyMaterialUpdate"("siteId", "date");

-- CreateIndex
CREATE INDEX "DailyIssueUpdate_siteId_date_idx" ON "DailyIssueUpdate"("siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyIssueUpdate_siteId_date_key" ON "DailyIssueUpdate"("siteId", "date");

-- CreateIndex
CREATE INDEX "DailySiteProgressUpdate_siteId_date_idx" ON "DailySiteProgressUpdate"("siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailySiteProgressUpdate_siteId_date_key" ON "DailySiteProgressUpdate"("siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorData_siteId_key" ON "ContractorData"("siteId");

-- CreateIndex
CREATE INDEX "AgreementData_siteId_createdAt_idx" ON "AgreementData"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "Request_siteId_createdAt_idx" ON "Request"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "Request_siteId_status_idx" ON "Request"("siteId", "status");

-- CreateIndex
CREATE INDEX "Request_siteId_stageName_idx" ON "Request"("siteId", "stageName");

-- CreateIndex
CREATE INDEX "Request_productId_createdAt_idx" ON "Request"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "Request_siteId_updatedAt_idx" ON "Request"("siteId", "updatedAt");

-- CreateIndex
CREATE INDEX "Request_status_updatedAt_idx" ON "Request"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "RequestStage_requestId_idx" ON "RequestStage"("requestId");

-- CreateIndex
CREATE INDEX "RequestStage_stageName_status_idx" ON "RequestStage"("stageName", "status");

-- CreateIndex
CREATE INDEX "RequestStage_userId_status_idx" ON "RequestStage"("userId", "status");

-- CreateIndex
CREATE INDEX "RequestStage_stageImageId_idx" ON "RequestStage"("stageImageId");

-- CreateIndex
CREATE UNIQUE INDEX "RequestStage_requestId_stageName_key" ON "RequestStage"("requestId", "stageName");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialTotal_siteId_key" ON "MaterialTotal"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "StageMaterial_siteId_key" ON "StageMaterial"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMember_userId_groupId_key" ON "ChatMember"("userId", "groupId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_userId_type_createdAt_idx" ON "Notification"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_type_title_createdAt_idx" ON "Notification"("userId", "type", "title", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_type_title_idx" ON "Notification"("type", "title");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_name_key" ON "Stage"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UserProduct_userId_productId_key" ON "UserProduct"("userId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteSupervisor_siteId_userId_key" ON "SiteSupervisor"("siteId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "SitePurchaser_siteId_userId_key" ON "SitePurchaser"("siteId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteSeniorEngineer_siteId_userId_key" ON "SiteSeniorEngineer"("siteId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMaterialUpdate" ADD CONSTRAINT "DailyMaterialUpdate_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyIssueUpdate" ADD CONSTRAINT "DailyIssueUpdate_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySiteProgressUpdate" ADD CONSTRAINT "DailySiteProgressUpdate_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorData" ADD CONSTRAINT "ContractorData_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementData" ADD CONSTRAINT "AgreementData_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestStage" ADD CONSTRAINT "RequestStage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestStage" ADD CONSTRAINT "RequestStage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestStage" ADD CONSTRAINT "RequestStage_stageImageId_fkey" FOREIGN KEY ("stageImageId") REFERENCES "RequestImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialTotal" ADD CONSTRAINT "MaterialTotal_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageMaterial" ADD CONSTRAINT "StageMaterial_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMember" ADD CONSTRAINT "ChatMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMember" ADD CONSTRAINT "ChatMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChatGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChatGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatGroup" ADD CONSTRAINT "ChatGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatGroup" ADD CONSTRAINT "ChatGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageItem" ADD CONSTRAINT "StageItem_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageItem" ADD CONSTRAINT "StageItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProduct" ADD CONSTRAINT "UserProduct_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProduct" ADD CONSTRAINT "UserProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraMaterial" ADD CONSTRAINT "ExtraMaterial_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraMaterial" ADD CONSTRAINT "ExtraMaterial_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSupervisor" ADD CONSTRAINT "SiteSupervisor_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSupervisor" ADD CONSTRAINT "SiteSupervisor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePurchaser" ADD CONSTRAINT "SitePurchaser_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePurchaser" ADD CONSTRAINT "SitePurchaser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSeniorEngineer" ADD CONSTRAINT "SiteSeniorEngineer_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSeniorEngineer" ADD CONSTRAINT "SiteSeniorEngineer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


