// R1: a loopback request is only the owner when it carries the per-launch owner cookie. Tests that play the owner add it with withOwner();
// a test that plays "something tunnelling raw TCP to the port" leaves it out.
const security = require('../../src/server/security');
const cookie = () => `${security.OWNER_COOKIE}=${security.ownerCookie().split(';')[0].split('=')[1]}`;
const withOwner = (headers = {}) => ({ ...headers, cookie: [cookie(), headers.cookie].filter(Boolean).join('; ') });
module.exports = { cookie, withOwner };
