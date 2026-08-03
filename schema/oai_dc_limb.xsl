<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:dc="http://purl.org/dc/elements/1.1/" 
    xmlns:exsl="http://exslt.org/common" extension-element-prefixes="exsl">
    
    <xsl:output method="xml" omit-xml-declaration="yes" indent="yes" />
    
    <xsl:variable name="uuid" select="/xml/item/@id" />
    
    <xsl:template match="/">
        <dc>
            <xsl:apply-templates />
        </dc>
    </xsl:template>
    
    <xsl:template match="/xml/MWDL/title">
        <dc:title><xsl:value-of select="." /></dc:title>
    </xsl:template>
    
    <xsl:template match="/xml/MWDL/formats">
        <xsl:for-each select="format">
            <dc:format><xsl:value-of select="." /></dc:format>
        </xsl:for-each>
    </xsl:template>
          
    <xsl:template match="/xml/MWDL/subjects">
        <xsl:for-each select="subject">
            <dc:subject><xsl:value-of select="." /></dc:subject>
        </xsl:for-each>
    </xsl:template>
    
    <xsl:template match="/xml/MWDL/creators">
        <xsl:for-each select="creator">
            <dc:creator><xsl:value-of select="." /></dc:creator>
        </xsl:for-each>
    </xsl:template>
    
    <xsl:template match="/xml/MWDL/description">
        <dc:description><xsl:value-of select="." /></dc:description>
    </xsl:template>
    
    <xsl:template match="/xml/MWDL/publisher">
        <dc:publisher><xsl:value-of select="." /></dc:publisher>
    </xsl:template>
    
    <xsl:template match="/xml/MWDL/date">
        <dc:date><xsl:value-of select="." /></dc:date>
    </xsl:template>
    
    <xsl:template match="/xml/item">
        <dc:item_status><xsl:value-of select="@itemstatus" /></dc:item_status>
        <dc:identifier><xsl:value-of select="concat('https://content.byui.edu/items/',@id,'/0/')" /></dc:identifier>
        <dc:date_created><xsl:value-of select="datecreated" /></dc:date_created>
        <dc:date_modified><xsl:value-of select="datemodified" /></dc:date_modified>		
        <dc:date_deleted><xsl:value-of select="datedeleted" /></dc:date_deleted>
        <!-- Begin Thumbnail Section -->
        <!-- Test for local thumbnails. Equella stores these and we can build the full url with the Item uuid -->
        <xsl:if test="attachments/attachment/@type &#61; 'local'">            
            <dc:thumbnail><xsl:value-of select="concat('https://content.byui.edu/file/', $uuid, '/1/', attachments/attachment/thumbnail)"/></dc:thumbnail>
        </xsl:if>    
        <!-- Test for a custom thumbnail. I've made the assumption that this will always be a full external url like the Kaltura thumbnails -->
        <xsl:if test="attachments/attachment/@type &#61; 'custom'">     
            <!-- Create an array from the node and then loop through each one until we find the thumbnail and then grab the string node with the URL -->
            <xsl:variable name="array" select="exsl:node-set(attachments/attachment/attributes/entry)"/>            
            <xsl:for-each select="$array">
                <xsl:if test="./string &#61; 'thumbUrl'">            
                    <dc:thumbnail><xsl:value-of select="./string[2]"/></dc:thumbnail>
                </xsl:if>                 
            </xsl:for-each>               
        </xsl:if>  
        <!-- End Thumbnail Section -->
    </xsl:template>
    
    <xsl:template match="/xml/HBCS/Geographic_Settings/Geographic_Setting">
        <dc:coverage><xsl:value-of select="." /></dc:coverage>
    </xsl:template>    
    
    <xsl:template match="text()" />    
    
    <xsl:template match="NewTemplate">
        
    </xsl:template>
</xsl:stylesheet>
