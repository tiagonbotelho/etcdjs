var request = require('request');
var roundround = require('roundround');

var noop = function() {};

var Stats = function(client) {
	this._client = client;
};

Stats.prototype.self = function(machine, cb) {
	if (typeof machine === 'function') return this.self(null, machine);
	this._client._request({uri:(machine || '')+'/v2/stats/self', json:true}, cb);
};

Stats.prototype.store = function(cb) {
	this._client._request({uri:'/v2/stats/store', json:true}, cb);
};

Stats.prototype.leader = function(cb) {
	this._client._request({uri:'/v2/stats/leader', json:true}, cb);
};

var Client = function(host, opts) {
	if (!(this instanceof Client)) return new Client(host, opts);
	if (!opts) opts = {};

	this._host = host;
	this._json = opts.json;
	this._timeout = opts.timeout || 60 * 1000;

	this.stats = new Stats(this);
};

Client.prototype.set = function(key, value, opts, cb) {
	if (typeof opts === 'function') return this.set(key, value, null, opts);
	if (!opts) opts = {};
	if (!cb) cb = noop;
	if (this._json) value = JSON.stringify(value);

	var form = {};

	if (value) form.value = value;
	if (opts.ttl) form.ttl = 'true';
	if (opts.dir) form.dir = 'true';

	if (opts.prevExist !== undefined) form.prevExist = ''+opts.prevExist;
	if (opts.prevValue !== undefined) form.prevValue = this._json ? JSON.stringify(opts.prevValue) : ''+opts.prevValue;
	if (opts.prevIndex !== undefined) form.prevIndex = ''+opts.prevIndex;

	this._request({
		method: 'PUT',
		uri: this._key(key),
		form: form,
		json: true
	}, cb);
};

Client.prototype.update = function(key, value, opts, cb) {
	if (typeof opts === 'function') return this.update(key, value, null, opts);
	if (!opts) opts = {};
	opts.prevExist = true;
	this.set(key, value, opts, cb);
};

Client.prototype.get = function(key, opts, cb) {
	if (typeof key === 'function') return this.get('', null, key);
	if (typeof opts === 'function') return this.get(key, null, opts);
	if (!opts) opts = {};

	var self = this;
	var qs = {};

	if (opts.wait) qs.wait = 'true';
	if (opts.waitIndex !== undefined) qs.waitIndex = ''+opts.waitIndex;
	if (opts.recursive) qs.recursive = 'true';
	if (opts.sorted) qs.sorted = 'true';
	if (opts.consistent) qs.consistent = 'true';

	this._request({
		uri: this._key(key),
		qs: qs,
		json: true,
		pool: opts.wait ? false : undefined
	}, cb);
};

Client.prototype.wait = function(key, opts, cb) {
	if (typeof opts === 'function') return this.wait(key, null, opts);
	if (!opts) opts = {};
	opts.wait = true;

	var self = this;
	var next = function(cb) {
		self.wait(key, opts, cb);
	};

	this.get(key, opts, function onresult(err, result) {
		if (err && err.code === 'ETIMEDOUT') return self.get(key, opts, onresult);
		if (result) opts.waitIndex = result.node.modifiedIndex + 1;
		if (err) return cb(err, null, next);
		cb(null, result, next);
	});
};

Client.prototype.del = Client.prototype.delete = function(key, opts, cb) {
	if (typeof key === 'function') return this.del('', null, key);
	if (typeof opts === 'function') return this.del(key, null, opts);
	if (!opts) opts = {};
	if (!cb) cb = noop;

	var qs = {};
	if (opts.prevExist !== undefined) qs.prevExist = ''+opts.prevExist;
	if (opts.prevValue !== undefined) qs.prevValue = this._json ? JSON.stringify(opts.prevValue) : ''+opts.prevValue;
	if (opts.prevIndex !== undefined) qs.prevIndex = ''+opts.prevIndex;
	if (opts.recursive) qs.recursive = 'true';
	if (opts.dir) qs.dir = 'true';

	this._request({
		method: 'DELETE',
		uri: this._key(key),
		qs: qs,
		json: true
	}, cb);
};

Client.prototype.compareAndSwap = function(key, val, prevValue, opts, cb) {
	if (typeof opts === 'function') return this.compareAndSwap(key, val, prevValue, null, opts);
	if (!opts) opts = {};
	if (!cb) cb = noop;

	opts.prevValue = prevValue;
	this.set(key, val, opts, cb);
};

Client.prototype.compareAndDelete = function(key, val, opts, cb) {
	if (typeof opts === 'function') return this.compareAndDelete(key, val, null, opts);
	if (!opts) opts = {};
	if (!cb) cb = noop;

	opts.prevValue = val;
	this.del(key, opts, cb);
};

Client.prototype.push = function(key, value, opts, cb) {
	if (typeof opts === 'function') return this.push(key, value, null, opts);
	if (!opts) opts = {};

	this._request({
		method: 'POST',
		uri: this._key(key),
		form: {
			value: value,
			ttl: opts.ttl
		},
		json: true
	}, cb);
};

Client.prototype.mkdir = function(key, opts, cb) {
	if (typeof opts === 'function') return this.mkdir(key, null, opts);
	if (!opts) opts = {};
	opts.dir = true;
	this.set(key, null, opts, cb);
};

Client.prototype.rmdir = function(key, opts, cb) {
	if (typeof opts === 'function') return this.rmdir(key, null, opts);
	if (!opts) opts = {};
	opts.dir = true;
	this.del(key, opts, cb);
};

Client.prototype._key = function(key) {
	return '/v2/keys/'+(key[0] === '/' ? key.slice(1) : key);
};

Client.prototype.machines = function(cb) {
	this._request({uri:'/v2/machines'}, function(err, body) {
		if (err) return cb(err);
		cb(null, body.trim().split(/\s*,\s*/));
	});
};

Client.prototype.leader = function(cb) {
	this._request({uri:'/v2/leader'}, cb);
};

var decodeJSON = function(node) {
	if (node.nodes) node.nodes.forEach(decodeAll);
	if (node.value !== undefined) node.value = JSON.parse(node.value);
};

var toError = function(response) {
	var body = response.body;
	if (!body || !body.message) return new Error('bad status: '+response.statusCode);

	var err = new Error(body.message);
	err.code = body.errorCode;
	err.cause = body.cause;
	err.index = body.index;

	return err;
};

Client.prototype._request = function(opts, cb) {
	if (opts.uri[0] === '/') opts.uri = this._host + opts.uri;

	var self = this;
	opts.timeout = this._timeout;
	request(opts, function onresponse(err, response) {
		if (err) return cb(err);

		if (response.statusCode === 307) return request(opts.uri = response.headers.location, opts, onresponse);
		if (response.statusCode === 404 && !opts.method || opts.method === 'GET') return cb();
		if (response.statusCode > 299)   return cb(toError(response));

		var body = response.body;
		if (!self.json) return cb(null, body);

		try {
			decodeJSON(body);
		} catch (err) {
			return cb(err);
		}

		cb(null, body);
	});
};

module.exports = Client;