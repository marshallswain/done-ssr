var Readable = require("stream").Readable;
var Steal = require("steal");
var configureLoader = require("./configure_loader");
var trigger = require("./trigger");
var Zone = require("can-zone");
var makeRender = require("./make_render");
var addCookies = require( "./cookies" );
var traceBundles = require("./bundles/index");
var util = require("util");

var ssrGlobalsZone = require("./zones/globals");
var canRouteDataZone = require("./zones/route_data");
var xhrZone = require("./zones/xhr");
var assetsZone = require("./zones/assets");
var html5shivZone = require("./zones/html5");
var responseZone = require("./zones/response");

global.doneSsr = {};

var doctype = '<!DOCTYPE html>';

module.exports = function(cfg, options){
	cfg = cfg || {};
	options = options || {};
	var steal = Steal.clone();
	var loader = global.System = steal.System;

	var nodeEnv = process.env.NODE_ENV || "development";
	loader.config({
		env: "server-" + nodeEnv
	});

	steal.config(cfg);

	// Configure the loader so that the virtual DOM is loaded
	configureLoader(loader, options);
	var bundleHelpers = traceBundles(loader);

	function getMainModule(main){
		// startup returns an Array in dev
		main = Array.isArray(main) ? main[0] : main;
		return main.importPromise || Promise.resolve(main);
	}

	var startup = steal.startup().then(function(main){
		if(!doneSsr.globalDocument && typeof document !== "undefined") {
			doneSsr.globalDocument = document;
		}

		// If live-reload is enabled we need to get a new main each
		// time a reload cycle is complete.
		if(loader.has("live-reload")) {
			var importOpts = {name: "@ssr"};
			loader.import("live-reload", importOpts).then(function(reload){
				reload(function(){
					startup = loader.import(loader.main).then(getMainModule);
				});
			});
		}
		return getMainModule(main);
	});

	var SSRStream = function(requestOrUrl){
		Readable.call(this);
		this.requestOrUrl = requestOrUrl;
		this.dests = [];
	};

	util.inherits(SSRStream, Readable);

	SSRStream.prototype._read = function(){
		if(this._renderPromise) { return; }
		this._renderPromise = this.render();
	};

	SSRStream.prototype.render = function(){
		var stream = this;
		var requestOrUrl = this.requestOrUrl;

		return startup.then(function(main){
			var request = typeof requestOrUrl === "string" ?
				{ url: requestOrUrl } : requestOrUrl;

			// Create the document
			var doc = new document.constructor();

			addCookies(doc, request);

			var serializeFromBody = !!(main.renderAsync ||
									   main.serializeFromBody);
			if(!serializeFromBody) {
				doc.head = doc.createElement("head");
				doc.documentElement.insertBefore(doc.head, doc.body);
			}
			var render = makeRender(main);

			var zonePlugins = [
				ssrGlobalsZone(doc, request, loader),
				canRouteDataZone,
				assetsZone(doc, bundleHelpers),
				responseZone(stream)
			];

			if(typeof XMLHttpRequest !== "undefined") {
				zonePlugins.push(xhrZone);
			}

			if(options.html5shiv) {
				zonePlugins.push(html5shivZone);
			}

			var zone = new Zone({
				plugins: zonePlugins
			});

			return zone.run(function(){

				render(request);

			}).then(function(data){
				var html;
				if(serializeFromBody) {
					html = doc.body.innerHTML;
				} else {
					html = doc.documentElement.outerHTML;
				}

				// Cleanup the dom
				trigger(doc, "removed");

				var dt = cfg.doctype || doctype;
				html = dt + "\n" + html;

				stream.push(html);
				stream.push(null);
			}, function(error){
				stream.emit("error", error);
			});
		});
	};

	SSRStream.prototype.pipe = function(dest){
		this.dests.push(dest);
		return Readable.prototype.pipe.apply(this, arguments);
	};


	return function(requestOrUrl){
		return new SSRStream(requestOrUrl);
	};
};
