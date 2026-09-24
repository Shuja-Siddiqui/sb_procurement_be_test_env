const { decode, sign } = require("jsonwebtoken");

class Response {
  sendResponse = (req, res, { data, message, status, id }) => {
    try {
      const obj = { data, message, status, id };
      if (!status) {
        obj.status = 200;
      }
      if (!message && !data) {
        return res.status(500).json({ message: "Data/Message is required" });
      }
      let token = null;
      if (
        req &&
        req?.headers.authorization &&
        req?.headers.authorization !== "undefined"
      ) {
        const t = req?.headers.authorization.split(" ")[1];
        const decoded = decode(t);
        delete decoded?.iat;
        delete decoded?.exp;
        if (decoded)
          token = sign(decoded, process.env.JWT_SECRET, { expiresIn: "30d" });
      }
      return res.status(obj.status).json({ ...obj, token });
    } catch (err) {
      console.log(err);
      return res
        .status(500)
        .json({ message: "Internal Server Error", status: 500 });
    }
  };
}

module.exports = Response;
