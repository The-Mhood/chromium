import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Preview signing credentials are generated locally by scripts/package-android.mjs and are never committed.
val signingFile = rootProject.file("../.android-signing/signing.properties")
val signingProps = Properties().apply {
    if (signingFile.exists()) signingFile.inputStream().use { load(it) }
}

android {
    namespace = "com.chromiumcore.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.chromiumcore.tv"
        minSdk = 23
        targetSdk = 34
        versionCode = 2
        versionName = "1.0.0"
    }

    signingConfigs {
        if (!signingProps.isEmpty()) {
            create("preview") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (!signingProps.isEmpty()) signingConfig = signingConfigs.getByName("preview")
        }
    }

    // The YouTube shield is shared with the desktop app, so it is packaged straight from the repository's shared/ folder.
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "../../shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
    testImplementation("junit:junit:4.13.2")
}
