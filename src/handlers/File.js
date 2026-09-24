const prisma = require("../lib/prisma");
const Response = require("./Response");

class File extends Response {


 upload = async (req, res) => {
    return this.sendResponse(req, res, {
      status: 410,
      message: "Excel binary storage is deprecated. Use object storage flow.",
    });
  };

  getFile = async (req, res) => {
    return this.sendResponse(req, res, {
      status: 410,
      message: "Excel binary storage is deprecated. Use object storage flow.",
    });
  };
}

module.exports = File;
