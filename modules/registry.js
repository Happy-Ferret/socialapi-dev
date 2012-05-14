/* -*- Mode: JavaScript; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Contributor(s):
 *  Michael Hanson <mhanson@mozilla.com>
 *  Edward Lee <edilee@mozilla.com>
 *  Mark Hammond <mhammond@mozilla.com>
 *  Shane Caraveo <scaraveo@mozilla.com>
 */

const {classes: Cc, interfaces: Ci, utils: Cu, manager: Cm} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://socialdev/modules/defaultprefs.js");
Cu.import("resource://socialdev/modules/provider.js");
Cu.import("resource://socialdev/modules/manifestDB.jsm");
Cu.import("resource://socialdev/modules/defaultServices.jsm");

const NS_XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const FRECENCY = 100;

function normalizeOriginPort(aURL) {
  try {
    let uri = Services.io.newURI(aURL, null, null);
    if (uri.scheme == 'resource') return aURL;
    return uri.hostPort;
  }
  catch(e) {
    Cu.reportError(e);
  }
  return aURL;
}


/**
 * getDefaultProviders
 *
 * look into our addon/feature dir and see if we have any builtin providers to install
 */
function getDefaultProviders() {
  var URIs = [];
  try {
    // figure out our installPath
    let res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    let installURI = Services.io.newURI("resource://socialdev/", null, null);
    let installPath = res.resolveURI(installURI);
    let installFile = Services.io.newURI(installPath, null, null);
    try {
      installFile = installFile.QueryInterface(Components.interfaces.nsIJARURI);
    } catch (ex) {} //not a jar file

    // load all prefs in defaults/preferences into a sandbox that has
    // a pref function
    let resURI = Services.io.newURI("resource://socialdev/providers", null, null);
    // If we're a XPI, load from the jar file
    if (installFile.JARFile) {
      let fileHandler = Components.classes["@mozilla.org/network/protocol;1?name=file"].
                  getService(Components.interfaces.nsIFileProtocolHandler);
      let fileName = fileHandler.getFileFromURLSpec(installFile.JARFile.spec);
      let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].
                      createInstance(Ci.nsIZipReader);
      try {
        zipReader.open(fileName);
        let entries = zipReader.findEntries("providers/*");
        while (entries.hasMore()) {
          var entryName = resURI.resolve(entries.getNext());
          if (entryName.indexOf("app.manifest") >= 0)
            URIs.push(entryName);
        }
      }
      finally {
        zipReader.close();
      }
    }
    else {
      let fURI = resURI.QueryInterface(Components.interfaces.nsIFileURL).file;
  
      var entries = fURI.directoryEntries;  
      while (entries.hasMoreElements()) {  
        var entry = entries.getNext();  
        entry.QueryInterface(Components.interfaces.nsIFile);
        URIs.push(resURI.resolve("providers/"+entry.leafName+"/app.manifest")); 
      }
    }
    //dump(JSON.stringify(URIs)+"\n");
  } catch(e) {
    Cu.reportError(e);
  }
  return URIs
}


/**
 * manifestRegistry is our internal api for registering manfist files that
   contain data for various services. It holds a registry of installed activity
   handlers, their mediators, and allows for invoking a mediator for installed
   services.
 */
function ManifestRegistry() {
  this._prefBranch = Services.prefs.getBranch("social.provider.").QueryInterface(Ci.nsIPrefBranch2);
  Services.obs.addObserver(this, "document-element-inserted", true);
  //Services.obs.addObserver(this, "origin-manifest-registered", true);
  //Services.obs.addObserver(this, "origin-manifest-unregistered", true);
  // later we can hook into webapp installs
  //Services.obs.addObserver(this, "openwebapp-installed", true);
  //Services.obs.addObserver(this, "openwebapp-uninstalled", true);

  // load the builtin providers if any
  let URIs = getDefaultProviders();
  for each(let uri in URIs) {
    this.loadManifest(null, uri, true);
  }
}

const manifestRegistryClassID = Components.ID("{8d764216-d779-214f-8da0-80e211d759eb}");
const manifestRegistryCID = "@mozilla.org/manifestRegistry;1";

ManifestRegistry.prototype = {
  classID: manifestRegistryClassID,
  contractID: manifestRegistryCID,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupportsWeakReference, Ci.nsIObserver]),

  _getUsefulness: function manifestRegistry_findMeABetterName(url, loginHost) {
    let hosturl = Services.io.newURI(url, null, null);
    loginHost = loginHost || hosturl.scheme+"://"+hosturl.host;
    return {
      hasLogin: hasLogin(loginHost),
      frecency: frecencyForUrl(hosturl.host)
    }
  },

  askUserInstall: function(aWindow, aCallback, location) {
    let origin = normalizeOriginPort(location);
    // BUG 732263 remember if the user says no, use that as a check in
    // discoverActivity so we bypass a lot of work.
    let nId = "manifest-ask-install";
    let nBox = aWindow.gBrowser.getNotificationBox();
    let notification = nBox.getNotificationWithValue(nId);

    // Check that we aren't already displaying our notification
    if (!notification) {
      let self = this;
      let message = "This site supports additional functionality for Firefox, would you like to install it?";

      buttons = [{
        label: "Yes",
        accessKey: null,
        callback: function () {
          aWindow.setTimeout(function () {
            aCallback();
          }, 0);
        }
      },
      {
        label: "Don't ask again",
        accessKey: 'd',
        callback: function() {
          self._prefBranch.setBoolPref(origin+".ignore", true);
        }
      }];
      nBox.appendNotification(message, nId, null,
                nBox.PRIORITY_INFO_MEDIUM,
                buttons);
    }
  },

  importManifest: function manifestRegistry_importManifest(aDocument, location, manifest, userRequestedInstall) {
    //Services.console.logStringMessage("got manifest "+JSON.stringify(manifest));
    let socialManifest = manifest.services.social;
    socialManifest.enabled = true;
    if (location.indexOf("resource:") == 0 && socialManifest.URLPrefix)
      location = socialManifest.URLPrefix
    function installManifest() {
      manifest.origin = location; // make this an origin
      // ensure remote installed social services cannot set contentPatchPath
      manifest.contentPatchPath = undefined;
      manifest.enabled = true;
      ManifestDB.put(location, socialManifest);
      registry().register(socialManifest);
      // XXX notification of installation
    }

    if (userRequestedInstall) {
      installManifest();
    }
    else {
      let info = this._getUsefulness(location);
      if (!info.hasLogin && info.frecency < FRECENCY) {
        //Services.console.logStringMessage("this site simply is not important, skip it");
        return;
      }
      // we reached here because the user has a login or visits this site
      // often, so we want to offer an install to the user
      //Services.console.logStringMessage("installing "+location+ " because "+JSON.stringify(info));
      // prompt user for install
      var xulWindow = aDocument.defaultView.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIWebNavigation)
                     .QueryInterface(Ci.nsIDocShellTreeItem)
                     .rootTreeItem
                     .QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindow);
      this.askUserInstall(xulWindow, function() {
        installManifest();
        // user requested install, lets make sure we enable after the install.
        // This is especially important on first time install.
        registry().enabled = true;
        let prefBranch = Services.prefs.getBranch("social.provider.").QueryInterface(Ci.nsIPrefBranch2);
        prefBranch.setBoolPref("visible", true);
        Services.obs.notifyObservers(null,
                                 "social-browsing-enabled",
                                 registry().currentProvider.origin);
      }, location)
      return;
    }
  },

  loadManifest: function manifestRegistry_loadManifest(aDocument, url, userRequestedInstall) {
    // BUG 732264 error and edge case handling
    let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIXMLHttpRequest);
    xhr.open('GET', url, true);
    let self = this;
    xhr.onreadystatechange = function(aEvt) {
      if (xhr.readyState == 4) {
        if (xhr.status == 200 || xhr.status == 0) {
          //Services.console.logStringMessage("got response "+xhr.responseText);
          try {
            self.importManifest(aDocument, url, JSON.parse(xhr.responseText), userRequestedInstall);
          }
          catch(e) {
            Cu.reportError("importManifest "+url+": "+e);
          }
        }
        else {
          Services.console.logStringMessage("got status "+xhr.status);
        }
      }
    };
    //Services.console.logStringMessage("fetch "+url);
    xhr.send(null);
  },

  discoverManifest: function manifestRegistry_discoverManifest(aDocument, aData) {
    // BUG 732266 this is probably heavy weight, is there a better way to watch for
    // links in documents?
    // https://developer.mozilla.org/En/Listening_to_events_in_Firefox_extensions
    // DOMLinkAdded event

    // TODO determine whether or not we actually want to load this
    // manifest.
    // 1. is it already loaded, skip it, we'll check it for updates another
    //    way
    // 2. does the user have a login for the site, if so, load it
    // 3. does the fecency for the site warrent loading the manifest and
    //    offering to the user?
    try {
      if (this._prefBranch.getBoolPref(aDocument.defaultView.location.host+".ignore")) {
        return;
      }
    } catch(e) {}

    let self = this;
    let links = aDocument.getElementsByTagName('link');
    for (let index=0; index < links.length; index++) {
      let link = links[index];
      if (link.getAttribute('rel') == 'manifest' &&
          link.getAttribute('type') == 'text/json') {
        //Services.console.logStringMessage("found manifest url "+link.getAttribute('href'));
        let baseUrl = aDocument.defaultView.location.href;
        let url = Services.io.newURI(baseUrl, null, null).resolve(link.getAttribute('href'));
        //Services.console.logStringMessage("base "+baseUrl+" resolved to "+url);
        ManifestDB.get(url, function(item) {
          if (!item) {
            self.loadManifest(aDocument, url);
          }
        });
      }
    }
  },

  /**
   * observer
   *
   * reset our mediators if an app is installed or uninstalled
   */
  observe: function manifestRegistry_observe(aSubject, aTopic, aData) {
    if (aTopic == "document-element-inserted") {
      if (!aSubject.defaultView)
        return;
      //Services.console.logStringMessage("new document "+aSubject.defaultView.location);
      this.discoverManifest(aSubject, aData);
      return;
    }
  }
};


const providerRegistryClassID = Components.ID("{1a60fb78-b2d2-104b-b16a-7f497be5626d}");
const providerRegistryCID = "@mozilla.org/socialProviderRegistry;1";

function ProviderRegistry() {
  dump("social registry service initializing\n");
  this.manifestRegistry = new ManifestRegistry();
  this._prefBranch = Services.prefs.getBranch("social.provider.").QueryInterface(Ci.nsIPrefBranch2);

  Services.obs.addObserver(this, 'quit-application', true);

  let self = this;
  ManifestDB.iterate(function(key, manifest) {
    self.register(manifest);
  });

  // we need to have our service injector running on startup of the
  // registry
  this.injectController = function(doc, topic, data) {
    try {
      // if we have attached 'service' on to the social-browser for the window
      // then we'll continue our injection.
      if (!doc.defaultView) return;
      var xulWindow = doc.defaultView.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIWebNavigation)
                     .QueryInterface(Ci.nsIDocShellTreeItem)
                     .rootTreeItem
                     .QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindow);
      // our service windows simply have browser attached to them
      var sbrowser = xulWindow.document.getElementById("social-status-sidebar-browser") || xulWindow.browser;
      var panelbrowser = xulWindow.document.getElementById("social-notification-browser");
      if (panelbrowser && panelbrowser.contentDocument == doc) sbrowser = panelbrowser;

      if (sbrowser && sbrowser.contentDocument == doc) {
        let service = sbrowser.service? sbrowser.service : xulWindow.service;
        if (service.workerURL)
          service.attachToWindow(doc.defaultView);
      // XXX dev code, allows us to load social panels into tabs and still
      // call attachToWindow on them
      //} else {
      //  for each(let svc in this._providers) {
      //    if ((doc.location+"").indexOf(svc.URLPrefix) == 0) {
      //      svc.attachToWindow(doc.defaultView);
      //      break;
      //    }
      //  };
      }
    }
    catch(e) {
      Cu.reportError("unable to attachToWindow for "+doc.location+":" + e);
      dump(e.stack+"\n");
    }
  };
  Services.obs.addObserver(this.injectController.bind(this), 'document-element-inserted', false);
}
ProviderRegistry.prototype = {
  classID: providerRegistryClassID,
  contractID: providerRegistryCID,
  QueryInterface: XPCOMUtils.generateQI([Ci.mozISocialRegistry,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver]),

  _providers: {},
  _currentProvider: null,
  _enabled: null,

  observe: function(aSubject, aTopic, aData) {
    if (aTopic == 'quit-application') {
      this.each(function(provider) {
        provider.shutdown();
      })
    }
  },

  register: function(manifest) {
    // we are not pushing into manifestDB here, rather manifestDB is calling us
    try {
      let provider = new SocialProvider(manifest);
      this._providers[manifest.origin] = provider;
      // registration on startup could happen in any order, so we avoid
      // setting this as "current".
    }
    catch(e) {
      Cu.reportError(e);
    }
  },
  _findCurrentProvider: function() {
    // workout what provider should be current.
    if (!this.enabled) {
      throw new Error("_findCurrentProvider should not be called when disabled.");
    }
    let origin = this._prefBranch.getCharPref("current");
    if (origin && this._providers[origin] && this._providers[origin].enabled) {
      return this._providers[origin];
    }
    // can't find it based on our prefs - just select any enabled one.
    for each(let provider in this._providers) {
      if (provider.enabled) {
        // this one will do.
        return provider;
      }
    }
    // should be impossible to get here; our enabled state should be false
    // if there are none we can select.
    return null;
  },
  get currentProvider() {
    // no concept of a "current" provider when we are disabled.
    if (!this.enabled) {
      return null;
    }
    return this._currentProvider;
  },
  set currentProvider(provider) {
    if (provider && !provider.enabled) {
      throw new Error("cannot set disabled provider as the current provider");
    }
    this._currentProvider = provider;
    try {
      this._prefBranch.setCharPref("current", provider.origin);
    }
    catch(e) {
      // just during dev, otherwise we shouldn't log here
      Cu.reportError(e);
    }
    Services.obs.notifyObservers(null,
                                 "social-browsing-current-service-changed",
                                 provider.origin);
  },
  get: function pr_get(origin) {
    return this._providers[origin];
  },
  each: function pr_iterate(cb) {
    for each(let provider in this._providers) {
      //cb.handle(provider);
      cb(provider);
    }
  },
  enableProvider: function(origin) {
    let provider = this._providers[origin];
    if (!provider) {
      return false;
    }

    ManifestDB.get(origin, function(manifest) {
      manifest.enabled = true;
      ManifestDB.put(origin, manifest);
      Services.obs.notifyObservers(null, "social-service-manifest-changed", origin);
    });
    provider.enabled = true;
    // if browsing is disabled we can't activate it!
    if (this.enabled) {
      provider.activate();
    }
    // nothing else to do - it is now available to be the current provider
    // but doesn't get that status simply because it was enabled.
    return true;
  },
  disableProvider: function(origin) {
    let provider = this._providers[origin];
    if (!provider) {
      return false;
    }

    provider.shutdown();
    provider.enabled = false;
    // and update the manifest.
    // XXX - this is wrong!  We should track that state elsewhere, otherwise
    // a manifest being updated by a provider loses this state!
    ManifestDB.get(origin, function(manifest) {
      manifest.enabled = false;
      ManifestDB.put(origin, manifest);
      Services.obs.notifyObservers(null, "social-service-manifest-changed", origin);
    });

    if (this._currentProvider && this._currentProvider == provider) {
      // it was current select a new current one.
      this._currentProvider = null;
      // however, if this was the last enabled service, then we must disable
      // social browsing completely.
      let numEnabled = 0;
      for each(let look in this._providers) {
        if (look.enabled) {
          numEnabled += 1;
        }
      }
      if (numEnabled == 0) {
        dump("provider disabled and no others are enabled - disabling social\n")
        this.enabled = false;
      } else {
        // don't call this.currentProvider as we don't want to set the pref!
        this._currentProvider = this._findCurrentProvider();
        Services.obs.notifyObservers(null,
                                     "social-browsing-current-service-changed",
                                     this._currentProvider.origin);
      }
    }
    return true;
  },

  // the rest of these methods are misplaced and should be in a generic
  // "social service" rather than the registry - but this will do for now
  // The global state of whether social browsing is enabled or not.
  get enabled() {
    if (this._enabled === null) {
      this.enabled = this._prefBranch.getBoolPref("enabled");
    }
    return this._enabled;
  },
  set enabled(new_state) {
    dump("registry set enabled " + new_state + " (current state is " + this._enabled + ")\n");
    if (new_state == this._enabled) {
      return;
    }
    this._enabled = new_state; // set early so later .enabled requests don't recurse.
    if (new_state) {
      for each(let provider in this._providers) {
        provider.activate();
      }
      let current = this._findCurrentProvider();
      if (current == null) {
        dump("attempted to enable browsing but no providers available\n");
        this._enabled = false;
        return;
      }
      // Set the current provider so anyone who asks as a result of the
      // social-browsing-enabled gets the right answer, but don't broadcast
      // about the new default until after,
      this._currentProvider = current;
      Services.obs.notifyObservers(null, "social-browsing-enabled", null);
      Services.obs.notifyObservers(null, "social-browsing-current-service-changed", null);
    } else {
      for each(let provider in this._providers) {
        provider.deactivate();
      }
      this._currentProvider = null;
      Services.obs.notifyObservers(null, "social-browsing-disabled", null);
    }
    this._prefBranch.setBoolPref("enabled", new_state);
  },
}

//const components = [ProviderRegistry];
//const NSGetFactory = XPCOMUtils.generateNSGetFactory(components);

providerRegistrySinglton = new ProviderRegistry();
function registry() providerRegistrySinglton;
const EXPORTED_SYMBOLS = ["registry"];