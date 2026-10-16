// R1: a loopback request is only the owner when it carries the per-launch owner cookie. Tests that play the owner add it with withOwner();
// a test that plays "something tunnelling raw TCP to the port" leaves it out.
const security = require('../../src/server/security');
// The cookie name carries the port of the Host header (finding 6), so the helper reads it from the request it decorates.
const cookie = (host) => security.ownerCookie(host).split(';')[0];
// `host` = the Host header the request will carry (a string), or a bare port number
const withOwner = (headers = {}, host) => ({ ...headers, cookie: [cookie(headers.Host || headers.host || (typeof host === 'number' ? `localhost:${host}` : host)), headers.cookie].filter(Boolean).join('; ') });
module.exports = { cookie, withOwner };
